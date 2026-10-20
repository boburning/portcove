import { releaseCanonicalDigest as capacityDigest } from "./release-canonical.mts";
export { capacityDigest };
import { isRecord } from "./runtime-values.mts";
import {
  inspectMetadataRenewalDescriptor,
  inspectPublishedMetadata,
  assertMetadataRenewalBinding,
  validatePublishedMetadataTransition,
  metadataInstant,
  inspectMetadataBootstrapDescriptor,
  assertMetadataBootstrapBinding,
} from "./release-metadata-contract.mts";

// Reviewed ceilings, not remaining storage, a reservation, or a billing quote.
export const slice4CapacityResources = Object.freeze({
  contract: "slice4-no-spend-v1",
  aggregate_workflow_sha256: "bee2037f33ae9a317af0b93a49eede17ddb81298f83d77e12f69bae7c4fd0a35",
  input_workflow_sha256: "086ed2c625bbd45b4849eee8598a65e9bdcb394d008f47f32a081965b1223b17",
  aggregate_job_minutes: Object.freeze([5, 25, 30, 5, 20]),
  input_job_minutes: Object.freeze([5, 5, 5]),
  aggregate_concurrency: "application-update-production-controller",
  input_concurrency: "portcove-release-reviewed-inputs",
  cancel_in_progress: false,
  total_job_minutes: 100,
  retention_days: 7,
  archive_bytes: 512 * 1024 * 1024,
  total_archive_bytes: 2 * 1024 * 1024 * 1024,
  assembly_file_bytes: 512 * 1024 * 1024,
  total_assembly_bytes: 2 * 1024 * 1024 * 1024,
  input_receipts: 3,
  input_receipt_bytes: 128 * 1024,
  shared_cache: false,
  enlarged_cache: false,
  paid_fallback: false,
  overwrite: false,
  unrelated_evidence_deletion: false,
});
export const slice4CapacityResourceDigest = capacityDigest(slice4CapacityResources);
function exact(value: unknown, keys: string): asserts value is Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== keys)
    throw new Error("bounded capacity schema differs");
}
function sha(value: unknown, length = 64): asserts value is string {
  if (
    typeof value !== "string" ||
    !(length === 40 ? /^[a-f0-9]{40}$/u : /^[a-f0-9]{64}$/u).test(value)
  )
    throw new Error("bounded capacity requires exact identities");
}
function text(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 512 ||
    Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new Error("bounded capacity identity text invalid");
}
export function inspectCapacityExecutorIdentity(raw: unknown) {
  exact(
    raw,
    "actor_id,check_run_id,controller_revision,execution_ref,job_id,role,run_attempt,run_id,workflow",
  );
  sha(raw.controller_revision, 40);
  for (const key of ["actor_id", "check_run_id", "run_id"] as const)
    if (typeof raw[key] !== "string" || !/^[1-9][0-9]{0,19}$/u.test(raw[key]))
      throw new Error("executor provider identity invalid");
  for (const key of ["job_id", "run_attempt"] as const)
    if (typeof raw[key] !== "number" || !Number.isSafeInteger(raw[key]) || raw[key] < 1)
      throw new Error("executor provider sequence invalid");
  text(raw.execution_ref);
  text(raw.workflow);
  if (
    !raw.execution_ref.startsWith("refs/tags/") ||
    raw.execution_ref.includes("..") ||
    raw.execution_ref.includes("//") ||
    !/^\.github\/workflows\/[a-z0-9][a-z0-9-]{0,100}\.ya?ml$/u.test(raw.workflow) ||
    ![
      "coordinator",
      "release-publication",
      "site-publication",
      "payload-signing",
      "tuf-releases",
      "tuf-preview",
      "tuf-stable",
      "tuf-snapshot",
      "tuf-timestamp",
    ].includes(String(raw.role))
  )
    throw new Error("executor fixed profile fields invalid");
  return {
    actor_id: raw.actor_id,
    check_run_id: raw.check_run_id,
    controller_revision: raw.controller_revision,
    execution_ref: raw.execution_ref,
    job_id: raw.job_id,
    role: raw.role,
    run_attempt: raw.run_attempt,
    run_id: raw.run_id,
    workflow: raw.workflow,
  };
}
function inspectRecoveryCounters(raw: Record<string, unknown>) {
  for (const [key, maximum] of [
    ["transient_retries", 2],
    ["substantive_repairs", 3],
  ] as const)
    if (
      typeof raw[key] !== "number" ||
      !Number.isInteger(raw[key]) ||
      raw[key] < 0 ||
      raw[key] > maximum
    )
      throw new Error("capacity intent exceeds existing recovery limits");
}
interface CapacityCandidate {
  source_commit: string;
  prepared_commit: string;
  version: string;
  transient_retries: number;
  substantive_repairs: number;
}
interface MetadataOperationSubject {
  descriptor_sha256: string;
  observed_at: string;
  prior_repository_sha256: string;
  transient_retries: number;
  substantive_repairs: number;
}
interface MetadataBootstrapOperationSubject {
  descriptor_sha256: string;
  observed_at: string;
  setup_plan_sha256: string;
  initial_site_preimage_sha256: string;
  transient_retries: number;
  substantive_repairs: number;
}
export interface ParsedCapacityOperation {
  before_checkpoint: string;
  candidate?: CapacityCandidate;
  metadata_renewal?: MetadataOperationSubject;
  metadata_bootstrap?: MetadataBootstrapOperationSubject;
  executor_nonce?: string;
  executor_identity?: ReturnType<typeof inspectCapacityExecutorIdentity>;
  receipt_limit?: number;
  destination: string;
  kind: string;
  policy_sha256: string;
  ratification_sha256: string;
  sequence: number;
  id: string;
  outcome: string;
  completed_effects: { remote_identity: string; evidence_sha256: string }[];
  failure_evidence: Record<string, unknown> | null;
  recovery: Record<string, unknown> | null;
}
export function inspectCapacityOperation(raw: unknown): ParsedCapacityOperation | null {
  if (raw === null) return null;
  const hasExecutor = isRecord(raw) && Object.hasOwn(raw, "executor_nonce");
  const hasIdentity = isRecord(raw) && Object.hasOwn(raw, "executor_identity");
  const metadata = isRecord(raw) && Object.hasOwn(raw, "metadata_renewal");
  const bootstrap = isRecord(raw) && Object.hasOwn(raw, "metadata_bootstrap");
  const receiptLimit = isRecord(raw) && Object.hasOwn(raw, "receipt_limit");
  exact(
    raw,
    [
      "before_checkpoint",
      bootstrap ? "metadata_bootstrap" : metadata ? "metadata_renewal" : "candidate",
      "completed_effects",
      "destination",
      ...(hasExecutor ? ["executor_nonce"] : []),
      ...(hasIdentity ? ["executor_identity"] : []),
      ...(receiptLimit ? ["receipt_limit"] : []),
      "failure_evidence",
      "id",
      "kind",
      "outcome",
      "policy_sha256",
      "ratification_sha256",
      "recovery",
      "sequence",
    ]
      .sort()
      .join(","),
  );
  if (hasExecutor) sha(raw.executor_nonce);
  const executorIdentity = hasIdentity
    ? inspectCapacityExecutorIdentity(raw.executor_identity)
    : null;
  if (
    receiptLimit &&
    (typeof raw.receipt_limit !== "number" ||
      !Number.isInteger(raw.receipt_limit) ||
      raw.receipt_limit < 1 ||
      raw.receipt_limit > 32)
  )
    throw new Error("capacity receipt limit invalid");
  sha(raw.before_checkpoint, 40);
  sha(raw.id);
  sha(raw.policy_sha256);
  sha(raw.ratification_sha256);
  text(raw.destination);
  if (bootstrap) {
    exact(
      raw.metadata_bootstrap,
      "descriptor_sha256,initial_site_preimage_sha256,observed_at,setup_plan_sha256,substantive_repairs,transient_retries",
    );
    sha(raw.metadata_bootstrap.descriptor_sha256);
    sha(raw.metadata_bootstrap.setup_plan_sha256);
    sha(raw.metadata_bootstrap.initial_site_preimage_sha256);
    metadataInstant(raw.metadata_bootstrap.observed_at);
    inspectRecoveryCounters(raw.metadata_bootstrap);
  } else if (metadata) {
    exact(
      raw.metadata_renewal,
      "descriptor_sha256,observed_at,prior_repository_sha256,substantive_repairs,transient_retries",
    );
    sha(raw.metadata_renewal.descriptor_sha256);
    sha(raw.metadata_renewal.prior_repository_sha256);
    metadataInstant(raw.metadata_renewal.observed_at);
    inspectRecoveryCounters(raw.metadata_renewal);
  } else {
    exact(
      raw.candidate,
      "prepared_commit,source_commit,substantive_repairs,transient_retries,version",
    );
    sha(raw.candidate.prepared_commit, 40);
    sha(raw.candidate.source_commit, 40);
    text(raw.candidate.version);
    inspectRecoveryCounters(raw.candidate);
  }
  if (
    !Number.isSafeInteger(raw.sequence) ||
    typeof raw.sequence !== "number" ||
    raw.sequence < 1 ||
    raw.sequence > 10000 ||
    !["dispatch", "upload", "retention"].includes(String(raw.kind)) ||
    !["pending", "succeeded", "capacity-refused", "ambiguous", "recovered"].includes(
      String(raw.outcome),
    ) ||
    !Array.isArray(raw.completed_effects) ||
    raw.completed_effects.length > (receiptLimit ? Number(raw.receipt_limit) : 32)
  )
    throw new Error("bounded capacity operation invalid");
  const completed = raw.completed_effects.map((effect: unknown) => {
    exact(effect, "evidence_sha256,remote_identity");
    sha(effect.evidence_sha256);
    text(effect.remote_identity);
    if (receiptLimit && Buffer.byteLength(effect.remote_identity) > 512)
      throw new Error("capacity receipt identity byte limit exceeded");
    return { evidence_sha256: effect.evidence_sha256, remote_identity: effect.remote_identity };
  });
  if (new Set(completed.map((effect) => effect.remote_identity)).size !== completed.length)
    throw new Error("duplicate capacity effect");
  if (raw.failure_evidence !== null) {
    exact(raw.failure_evidence, "evidence_sha256,remote_identity");
    sha(raw.failure_evidence.evidence_sha256);
    text(raw.failure_evidence.remote_identity);
  }
  if (raw.outcome === "capacity-refused" && raw.failure_evidence === null)
    throw new Error("capacity refusal needs retained exact evidence");
  if (raw.outcome === "succeeded" && completed.length === 0)
    throw new Error("successful capacity operation requires exact completed evidence");
  if (raw.outcome === "recovered") {
    const recoveryExecutor =
      isRecord(raw.recovery) && Object.hasOwn(raw.recovery, "executor_identity");
    exact(
      raw.recovery,
      recoveryExecutor
        ? "checkpoint,evidence_sha256,executor_identity,resolution"
        : "checkpoint,evidence_sha256,resolution",
    );
    if (recoveryExecutor) inspectCapacityExecutorIdentity(raw.recovery.executor_identity);
    sha(raw.recovery.checkpoint, 40);
    sha(raw.recovery.evidence_sha256);
    if (
      !["effect-completed", "effect-not-applied", "partial-effects-retained"].includes(
        String(raw.recovery.resolution),
      )
    )
      throw new Error("capacity recovery unresolved");
    if (raw.recovery.resolution === "effect-not-applied" && completed.length !== 0)
      throw new Error("effect-not-applied contradicts retained completed effects");
  } else if (raw.recovery !== null) throw new Error("unresolved operation cannot assert recovery");
  const subject: {
    candidate?: CapacityCandidate;
    metadata_renewal?: MetadataOperationSubject;
    metadata_bootstrap?: MetadataBootstrapOperationSubject;
  } = bootstrap
    ? {
        metadata_bootstrap: {
          descriptor_sha256: String(
            (raw.metadata_bootstrap as Record<string, unknown>).descriptor_sha256,
          ),
          setup_plan_sha256: String(
            (raw.metadata_bootstrap as Record<string, unknown>).setup_plan_sha256,
          ),
          initial_site_preimage_sha256: String(
            (raw.metadata_bootstrap as Record<string, unknown>).initial_site_preimage_sha256,
          ),
          observed_at: String((raw.metadata_bootstrap as Record<string, unknown>).observed_at),
          transient_retries: Number(
            (raw.metadata_bootstrap as Record<string, unknown>).transient_retries,
          ),
          substantive_repairs: Number(
            (raw.metadata_bootstrap as Record<string, unknown>).substantive_repairs,
          ),
        },
      }
    : metadata
      ? {
          metadata_renewal: {
            descriptor_sha256: String(
              (raw.metadata_renewal as Record<string, unknown>).descriptor_sha256,
            ),
            observed_at: String((raw.metadata_renewal as Record<string, unknown>).observed_at),
            prior_repository_sha256: String(
              (raw.metadata_renewal as Record<string, unknown>).prior_repository_sha256,
            ),
            transient_retries: Number(
              (raw.metadata_renewal as Record<string, unknown>).transient_retries,
            ),
            substantive_repairs: Number(
              (raw.metadata_renewal as Record<string, unknown>).substantive_repairs,
            ),
          },
        }
      : {
          candidate: {
            source_commit: String((raw.candidate as Record<string, unknown>).source_commit),
            prepared_commit: String((raw.candidate as Record<string, unknown>).prepared_commit),
            version: String((raw.candidate as Record<string, unknown>).version),
            transient_retries: Number((raw.candidate as Record<string, unknown>).transient_retries),
            substantive_repairs: Number(
              (raw.candidate as Record<string, unknown>).substantive_repairs,
            ),
          },
        };
  const identity = {
    before_checkpoint: raw.before_checkpoint,
    ...subject,
    destination: raw.destination,
    ...(hasExecutor ? { executor_nonce: String(raw.executor_nonce) } : {}),
    ...(executorIdentity ? { executor_identity: executorIdentity } : {}),
    ...(receiptLimit ? { receipt_limit: Number(raw.receipt_limit) } : {}),
    kind: String(raw.kind),
    policy_sha256: raw.policy_sha256,
    ratification_sha256: raw.ratification_sha256,
    sequence: raw.sequence,
  };
  if (capacityDigest(identity) !== raw.id) throw new Error("capacity operation identity differs");
  return {
    ...identity,
    id: raw.id,
    outcome: String(raw.outcome),
    completed_effects: completed,
    failure_evidence: raw.failure_evidence,
    recovery: raw.recovery,
  };
}

/** Facts are supplied by the admitted fixed caller, never authenticated by this
 * pure parser or by journal persistence. No default budget API or billing App.
 * A ratification is revocable; its owner must invalidate it BEFORE boundary
 * changes. Unreported provider changes cannot be detected by digest equality.
 */
export function assessBoundedCapacity(raw: unknown) {
  exact(raw, "boundary,operation,prior_operations,ratification,schema_version");
  if (raw.schema_version !== 1 && raw.schema_version !== 2)
    throw new Error("unsupported bounded capacity contract");
  if (raw.schema_version === 2) inspectCompactCapacityOperations(raw.prior_operations);
  else inspectPriorCapacityOperations(raw.prior_operations);
  if (
    raw.schema_version === 1 &&
    isRecord(raw.operation) &&
    (Object.hasOwn(raw.operation, "metadata_renewal") ||
      Object.hasOwn(raw.operation, "metadata_bootstrap"))
  )
    throw new Error("metadata operations require bounded capacity schema2");
  if (
    raw.schema_version === 1 &&
    Array.isArray(raw.prior_operations) &&
    raw.prior_operations.some(
      (entry) => isRecord(entry) && Object.hasOwn(entry, "summary_schema_version"),
    )
  )
    throw new Error("compact summaries require bounded capacity schema2");
  exact(raw.ratification, "active,boundary_sha256,resource_policy_sha256,selection");
  sha(raw.ratification.boundary_sha256);
  sha(raw.ratification.resource_policy_sha256);
  if (
    typeof raw.ratification.active !== "boolean" ||
    raw.ratification.selection !== "slice4-d2-c6470ec28ba9addb0f70d9f86953322d835bb8c0"
  )
    throw new Error("capacity ratification invalid");
  let reason = "bounded attempt eligible under supplied ratified no-spend facts";
  let eligible = true;
  if (!raw.ratification.active) {
    eligible = false;
    reason = "capacity ratification revoked";
  } else if (raw.ratification.resource_policy_sha256 !== slice4CapacityResourceDigest) {
    eligible = false;
    reason = "capacity resource policy changed";
  } else if (raw.boundary === null) {
    eligible = false;
    reason = "admitted spending-boundary source unavailable";
  } else {
    exact(
      raw.boundary,
      "account_id,budget_id,budget_usd,configuration_generation,product,public_repository,repository_id,resource_policy_sha256,runner_class,scope,stop_usage",
    );
    text(raw.boundary.budget_id);
    text(raw.boundary.configuration_generation);
    if (
      raw.boundary.account_id !== 43177418 ||
      raw.boundary.repository_id !== 1354613114 ||
      raw.boundary.product !== "Actions" ||
      raw.boundary.scope !== "account" ||
      raw.boundary.budget_usd !== 0 ||
      raw.boundary.stop_usage !== true ||
      raw.boundary.public_repository !== true ||
      raw.boundary.runner_class !== "standard-public" ||
      raw.boundary.resource_policy_sha256 !== slice4CapacityResourceDigest ||
      capacityDigest(raw.boundary) !== raw.ratification.boundary_sha256
    ) {
      eligible = false;
      reason = "spending, account, runner or resource boundary changed";
    }
  }
  const operation = inspectCapacityOperation(raw.operation);
  if (operation && !["succeeded", "recovered"].includes(operation.outcome)) {
    eligible = false;
    reason =
      "pending, refused or ambiguous operation requires existing checkpoint/readback recovery";
  }
  return {
    schema_version: raw.schema_version,
    contract:
      raw.schema_version === 1
        ? "provider-no-spend-bounded-attempt-v1"
        : "provider-no-spend-bounded-attempt-v2",
    eligibility: eligible ? "eligible" : "ineligible",
    reason,
    availability: "unknown",
    headroom: "unknown",
    reservation: "none",
    resource_policy_sha256: slice4CapacityResourceDigest,
    ratification_sha256: capacityDigest(raw.ratification),
    operation,
    resource_estimate: slice4CapacityResources,
    qualification: "supplied boundary facts only; no producer authentication or execution grant",
    authority: "none",
  };
}

/** Bounded anti-repeat summary carried by the existing portable checkpoint. */
export function inspectPriorCapacityOperations(raw: unknown) {
  if (!Array.isArray(raw) || raw.length > 32)
    throw new Error("capacity prior-operation summary exceeds bound");
  const operations = raw.map(inspectCapacityOperation);
  if (
    operations.some((op) => !op || !["succeeded", "recovered"].includes(op.outcome)) ||
    new Set(operations.map((op) => op?.id)).size !== operations.length
  )
    throw new Error("capacity prior-operation summary must retain unique resolved effects");
  return operations;
}

type Operation = NonNullable<ReturnType<typeof inspectCapacityOperation>>;
export interface CapacityOperationGroup {
  summary_schema_version: 1;
  subject: { kind: "candidate" | "metadata-renewal" | "metadata-bootstrap"; identity: string };
  kind: string;
  destination_sha256: string;
  transient_retries: number;
  substantive_repairs: number;
  completed: boolean;
  attempts: { checkpoint: string; id: string; operation_sha256: string }[];
}
export function capacityOperationSubject(operation: Operation) {
  if (isRecord(operation.metadata_bootstrap))
    return {
      kind: "metadata-bootstrap" as const,
      identity: String(operation.metadata_bootstrap.descriptor_sha256),
    };
  if (isRecord(operation.metadata_renewal))
    return {
      kind: "metadata-renewal" as const,
      identity: String(operation.metadata_renewal.prior_repository_sha256),
    };
  if (!isRecord(operation.candidate)) throw new Error("capacity operation subject absent");
  return { kind: "candidate" as const, identity: String(operation.candidate.prepared_commit) };
}
export function capacityOperationCounters(operation: Operation) {
  const source = isRecord(operation.metadata_bootstrap)
    ? operation.metadata_bootstrap
    : isRecord(operation.metadata_renewal)
      ? operation.metadata_renewal
      : operation.candidate;
  if (!isRecord(source)) throw new Error("capacity operation counters absent");
  return {
    transient_retries: Number(source.transient_retries),
    substantive_repairs: Number(source.substantive_repairs),
  };
}
function groupKey(group: Pick<CapacityOperationGroup, "subject" | "kind" | "destination_sha256">) {
  return capacityDigest({
    subject: group.subject,
    kind: group.kind,
    destination_sha256: group.destination_sha256,
  });
}
export function inspectCompactCapacityOperations(raw: unknown): CapacityOperationGroup[] {
  if (!Array.isArray(raw) || raw.length > 96)
    throw new Error("compact capacity summary exceeds bounded lifecycle limit");
  const groups = raw.map((entry): CapacityOperationGroup => {
    exact(
      entry,
      "attempts,completed,destination_sha256,kind,subject,substantive_repairs,summary_schema_version,transient_retries",
    );
    exact(entry.subject, "identity,kind");
    if (
      entry.subject.kind !== "candidate" &&
      entry.subject.kind !== "metadata-renewal" &&
      entry.subject.kind !== "metadata-bootstrap"
    )
      throw new Error("compact capacity subject invalid");
    sha(entry.subject.identity, entry.subject.kind === "candidate" ? 40 : 64);
    sha(entry.destination_sha256);
    inspectRecoveryCounters(entry);
    if (
      entry.summary_schema_version !== 1 ||
      typeof entry.completed !== "boolean" ||
      !["dispatch", "upload", "retention"].includes(String(entry.kind)) ||
      !Array.isArray(entry.attempts) ||
      entry.attempts.length < 1 ||
      entry.attempts.length > 6
    )
      throw new Error("compact capacity facts invalid");
    const attempts = entry.attempts.map((proof: unknown) => {
      exact(proof, "checkpoint,id,operation_sha256");
      sha(proof.checkpoint, 40);
      sha(proof.id);
      sha(proof.operation_sha256);
      return {
        checkpoint: proof.checkpoint,
        id: proof.id,
        operation_sha256: proof.operation_sha256,
      };
    });
    if (new Set(attempts.map((proof) => proof.id)).size !== attempts.length)
      throw new Error("duplicate compact capacity proof");
    return {
      summary_schema_version: 1,
      subject: { kind: entry.subject.kind, identity: entry.subject.identity },
      kind: String(entry.kind),
      destination_sha256: entry.destination_sha256,
      transient_retries: Number(entry.transient_retries),
      substantive_repairs: Number(entry.substantive_repairs),
      completed: entry.completed,
      attempts,
    };
  });
  if (new Set(groups.map(groupKey)).size !== groups.length)
    throw new Error("duplicate compact capacity logical effect");
  return groups;
}
function appendOperation(
  groups: CapacityOperationGroup[],
  operation: Operation,
  checkpoint: string,
) {
  if (!["succeeded", "recovered"].includes(operation.outcome))
    throw new Error("only resolved effects may be compacted");
  const subject = capacityOperationSubject(operation),
    counters = capacityOperationCounters(operation);
  const key = groupKey({
    subject,
    kind: String(operation.kind),
    destination_sha256: capacityDigest(operation.destination),
  });
  const proof = { checkpoint, id: operation.id, operation_sha256: capacityDigest(operation) };
  const completed =
    operation.outcome === "succeeded" ||
    (operation.receipt_limit === 1 && operation.completed_effects.length === 1) ||
    (isRecord(operation.recovery) && operation.recovery.resolution === "effect-completed");
  const previous = groups.find((group) => groupKey(group) === key);
  if (previous) {
    if (previous.attempts.some((entry) => entry.id === operation.id))
      throw new Error("raw capacity operation already summarized");
    previous.attempts.push(proof);
    previous.completed ||= completed;
    previous.transient_retries = Math.max(previous.transient_retries, counters.transient_retries);
    previous.substantive_repairs = Math.max(
      previous.substantive_repairs,
      counters.substantive_repairs,
    );
  } else
    groups.push({
      summary_schema_version: 1,
      subject,
      kind: String(operation.kind),
      destination_sha256: capacityDigest(operation.destination),
      ...counters,
      completed,
      attempts: [proof],
    });
  groups.sort((a, b) => (groupKey(a) < groupKey(b) ? -1 : groupKey(a) > groupKey(b) ? 1 : 0));
  return inspectCompactCapacityOperations(groups);
}
function inputCapacity(input: Record<string, unknown>) {
  return isRecord(input.controller) && isRecord(input.controller.capacity_attempt)
    ? input.controller.capacity_attempt
    : null;
}
export function expectedCompactCapacityOperations(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
  checkpoint: string,
) {
  sha(checkpoint, 40);
  const beforeCapacity = inputCapacity(previous),
    afterCapacity = inputCapacity(next);
  let groups: CapacityOperationGroup[] = [];
  if (beforeCapacity?.schema_version === 2)
    groups = structuredClone(inspectCompactCapacityOperations(beforeCapacity.prior_operations));
  else if (beforeCapacity)
    for (const operation of inspectPriorCapacityOperations(beforeCapacity.prior_operations))
      if (operation) groups = appendOperation(groups, operation, checkpoint);
  const before = beforeCapacity ? inspectCapacityOperation(beforeCapacity.operation) : null,
    after = afterCapacity ? inspectCapacityOperation(afterCapacity.operation) : null;
  if (before && after && before.id !== after.id)
    groups = appendOperation(groups, before, checkpoint);
  const active = isRecord(next.active_candidate) ? next.active_candidate.prepared_commit : null;
  const published = inspectPublishedMetadata(next.published_metadata);
  return groups.filter((group) =>
    group.subject.kind === "candidate"
      ? group.subject.identity === active
      : group.subject.kind === "metadata-bootstrap"
        ? !published &&
          next.metadata_bootstrap != null &&
          group.subject.identity ===
            capacityDigest(inspectMetadataBootstrapDescriptor(next.metadata_bootstrap))
        : group.subject.identity === published?.repository_sha256,
  );
}
export function verifyRetainedCapacityOperation(
  raw: unknown,
  proof: { id: string; operation_sha256: string },
) {
  const operation = inspectCapacityOperation(raw);
  if (
    !operation ||
    operation.id !== proof.id ||
    capacityDigest(operation) !== proof.operation_sha256
  )
    throw new Error("retained raw capacity operation differs from immutable checkpoint proof");
  return operation;
}

function validateCapacityV2(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
  checkpoint: string,
) {
  const priorCapacity = inputCapacity(previous),
    capacity = inputCapacity(next);
  if (next.schema_version !== 2 || capacity?.schema_version !== 2)
    throw new Error("bounded capacity schema2 cannot downgrade");
  const before = priorCapacity ? inspectCapacityOperation(priorCapacity.operation) : null,
    after = inspectCapacityOperation(capacity.operation);
  const newIntent = after && (!before || before.id !== after.id);
  const previousBootstrap =
    previous.metadata_bootstrap == null
      ? null
      : inspectMetadataBootstrapDescriptor(previous.metadata_bootstrap);
  if (previous.opportunity !== null && next.opportunity === null)
    throw new Error("initial metadata state cannot erase an existing semantic opportunity");
  const nextBootstrap =
    next.metadata_bootstrap == null
      ? null
      : inspectMetadataBootstrapDescriptor(next.metadata_bootstrap);
  if (previousBootstrap && capacityDigest(previousBootstrap) !== capacityDigest(nextBootstrap))
    throw new Error("initial bootstrap descriptor cannot disappear or be replaced");
  if (
    !previousBootstrap &&
    nextBootstrap &&
    (inspectPublishedMetadata(previous.published_metadata) ||
      inspectPublishedMetadata(next.published_metadata) ||
      (before && !["succeeded", "recovered"].includes(before.outcome)) ||
      capacityDigest(previous.active_candidate) !== capacityDigest(next.active_candidate))
  )
    throw new Error("initial bootstrap cannot start after publication or rewrite a reservation");
  if (
    capacityDigest(previous.published_metadata ?? null) !==
      capacityDigest(next.published_metadata ?? null) &&
    newIntent
  )
    throw new Error("metadata readback must be durable before a new effect intent");
  validatePublishedMetadataTransition(previous, next, after);
  const retained = inspectCompactCapacityOperations(capacity.prior_operations);
  if (
    capacityDigest(retained) !==
    capacityDigest(expectedCompactCapacityOperations(previous, next, checkpoint))
  )
    throw new Error("compact capacity summary cannot drop or rewrite lifecycle effects");
  if (before && !after) throw new Error("capacity operation cannot disappear");
  if (!after) return;
  if (before && before.id === after.id && capacityDigest(before) === capacityDigest(after)) {
    if (
      !["succeeded", "recovered"].includes(before.outcome) &&
      capacityDigest(previous.active_candidate) !== capacityDigest(next.active_candidate)
    )
      throw new Error("unresolved capacity effects must preserve reservation");
    if (
      !["succeeded", "recovered"].includes(before.outcome) &&
      (capacityDigest(previous.metadata_renewal ?? null) !==
        capacityDigest(next.metadata_renewal ?? null) ||
        capacityDigest(previous.metadata_bootstrap ?? null) !==
          capacityDigest(next.metadata_bootstrap ?? null))
    )
      throw new Error("unresolved metadata intent cannot change its frozen descriptor");
    return;
  }
  if (isRecord(after.metadata_bootstrap)) {
    const descriptor = inspectMetadataBootstrapDescriptor(next.metadata_bootstrap);
    if (
      after.metadata_bootstrap.descriptor_sha256 !== capacityDigest(descriptor) ||
      after.metadata_bootstrap.setup_plan_sha256 !== descriptor.setup_plan_sha256 ||
      after.metadata_bootstrap.initial_site_preimage_sha256 !==
        descriptor.initial_site_preimage_sha256
    )
      throw new Error("initial bootstrap effect differs from frozen setup descriptor");
    if (newIntent)
      assertMetadataBootstrapBinding(
        descriptor,
        inspectPublishedMetadata(next.published_metadata),
        after.metadata_bootstrap.observed_at,
      );
    if (capacityDigest(previous.active_candidate) !== capacityDigest(next.active_candidate))
      throw new Error("initial bootstrap effect cannot change active candidate");
  } else if (isRecord(after.metadata_renewal)) {
    const descriptor = inspectMetadataRenewalDescriptor(next.metadata_renewal);
    if (
      after.metadata_renewal.descriptor_sha256 !== capacityDigest(descriptor) ||
      after.metadata_renewal.prior_repository_sha256 !== descriptor.prior_repository_sha256
    )
      throw new Error("metadata effect differs from frozen descriptor");
    if (newIntent)
      assertMetadataRenewalBinding(
        descriptor,
        inspectPublishedMetadata(next.published_metadata),
        after.metadata_renewal.observed_at,
      );
    if (capacityDigest(previous.active_candidate) !== capacityDigest(next.active_candidate))
      throw new Error("metadata effect cannot change active candidate");
  } else {
    const active = next.active_candidate;
    if (
      !isRecord(active) ||
      capacityDigest(after.candidate) !==
        capacityDigest({
          source_commit: active.source_commit,
          prepared_commit: active.prepared_commit,
          version: active.version,
          transient_retries: active.transient_retries,
          substantive_repairs: active.substantive_repairs,
        })
    )
      throw new Error("capacity operation changed frozen candidate");
  }
  if (newIntent) {
    if (before && !["succeeded", "recovered"].includes(before.outcome))
      throw new Error("new capacity intent cannot bypass unresolved effects");
    if (
      after.outcome !== "pending" ||
      after.completed_effects.length !== 0 ||
      after.before_checkpoint !== checkpoint ||
      after.sequence !== (before?.sequence ?? 0) + 1
    )
      throw new Error("capacity effect requires exact preceding pending checkpoint");
    const ready = assessBoundedCapacity({ ...capacity, operation: before });
    if (
      ready.eligibility !== "eligible" ||
      after.policy_sha256 !== ready.resource_policy_sha256 ||
      after.ratification_sha256 !== ready.ratification_sha256
    )
      throw new Error("bounded attempt ineligible");
    if (capacityDigest(previous.active_candidate) !== capacityDigest(next.active_candidate))
      throw new Error("pending effect must retain reservation progress");
    const subject = capacityOperationSubject(after),
      counters = capacityOperationCounters(after);
    const lifecycle = retained.filter(
      (group) => capacityDigest(group.subject) === capacityDigest(subject),
    );
    const transient = Math.max(0, ...lifecycle.map((group) => group.transient_retries)),
      substantive = Math.max(0, ...lifecycle.map((group) => group.substantive_repairs));
    if (counters.transient_retries < transient || counters.substantive_repairs < substantive)
      throw new Error("capacity lifecycle recovery counters regressed");
    const repeated = lifecycle.find(
      (group) =>
        group.kind === after.kind && group.destination_sha256 === capacityDigest(after.destination),
    );
    if (repeated?.completed) throw new Error("completed logical effect cannot repeat");
    if (
      repeated &&
      counters.transient_retries <= transient &&
      counters.substantive_repairs <= substantive
    )
      throw new Error("same-effect retry requires fresh bounded recovery increment");
    if (subject.kind === "metadata-renewal" || subject.kind === "metadata-bootstrap") {
      const increase =
        counters.transient_retries - transient + counters.substantive_repairs - substantive;
      if (increase !== (repeated ? 1 : 0))
        throw new Error("metadata recovery must consume exactly one existing increment");
    }
    return;
  }
  if (!before) throw new Error("capacity outcome lacks preceding intent");
  // The complete intent, including source/descriptor, executor and nonce, stays
  // immutable while recording outcomes or explicit readback recovery.
  const intent = (op: Operation) => {
    const { completed_effects, failure_evidence, recovery, outcome, ...identity } = op;
    void completed_effects;
    void failure_evidence;
    void recovery;
    void outcome;
    return identity;
  };
  if (capacityDigest(intent(before)) !== capacityDigest(intent(after)))
    throw new Error("capacity executor or frozen intent changed");
  if (
    capacityDigest(before.completed_effects) !==
    capacityDigest(after.completed_effects.slice(0, before.completed_effects.length))
  )
    throw new Error("completed effects regressed");
  if (["succeeded", "recovered"].includes(before.outcome)) {
    if (capacityDigest(before) !== capacityDigest(after))
      throw new Error("resolved outcome cannot change");
  } else if (after.outcome === "recovered") {
    if (
      !isRecord(after.recovery) ||
      after.recovery.checkpoint !== checkpoint ||
      capacityDigest(before.failure_evidence) !== capacityDigest(after.failure_evidence)
    )
      throw new Error("recovery differs from actual checkpoint/failure");
  } else if (before.outcome !== "pending" && capacityDigest(before) !== capacityDigest(after))
    throw new Error("failed outcome needs explicit readback");
  if (
    capacityDigest(previous.active_candidate) !== capacityDigest(next.active_candidate) ||
    capacityDigest(previous.metadata_renewal ?? null) !==
      capacityDigest(next.metadata_renewal ?? null) ||
    capacityDigest(previous.metadata_bootstrap ?? null) !==
      capacityDigest(next.metadata_bootstrap ?? null)
  )
    throw new Error("capacity outcome cannot rewrite reservation or metadata descriptor");
}
/** Called inside the existing journal's transition validation. No new journal. */
export function validateCapacityTransition(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
  checkpoint: string,
) {
  if (
    inputCapacity(previous)?.schema_version === 2 ||
    inputCapacity(next)?.schema_version === 2 ||
    Object.hasOwn(previous, "published_metadata") ||
    Object.hasOwn(next, "published_metadata") ||
    Object.hasOwn(previous, "metadata_renewal") ||
    Object.hasOwn(next, "metadata_renewal") ||
    Object.hasOwn(previous, "metadata_bootstrap") ||
    Object.hasOwn(next, "metadata_bootstrap")
  )
    return validateCapacityV2(previous, next, checkpoint);
  if (previous.schema_version === 2 && next.schema_version !== 2)
    throw new Error("capacity schema cannot downgrade to legacy availability");
  const get = (input: Record<string, unknown>) =>
    isRecord(input.controller) && isRecord(input.controller.capacity_attempt)
      ? inspectCapacityOperation(input.controller.capacity_attempt.operation)
      : null;
  const before = get(previous),
    after = get(next);
  if (next.schema_version !== 2) return;
  const prior =
    isRecord(previous.controller) && isRecord(previous.controller.capacity_attempt)
      ? inspectPriorCapacityOperations(previous.controller.capacity_attempt.prior_operations)
      : [];
  const retained =
    isRecord(next.controller) && isRecord(next.controller.capacity_attempt)
      ? inspectPriorCapacityOperations(next.controller.capacity_attempt.prior_operations)
      : [];
  const newIntent = after && (!before || before.id !== after.id);
  const expectedPrior = newIntent
    ? [...prior, ...(before ? [before] : [])].filter(
        (op) =>
          isRecord(op?.candidate) &&
          isRecord(after.candidate) &&
          op.candidate.prepared_commit === after.candidate.prepared_commit,
      )
    : prior;
  if (capacityDigest(retained) !== capacityDigest(expectedPrior))
    throw new Error("capacity prior-operation summary cannot drop or rewrite effects");
  if (!before && !after) return;
  if (before && !after) throw new Error("capacity operation cannot disappear");
  if (!after) return;
  if (before && before.id === after.id && capacityDigest(before) === capacityDigest(after)) {
    if (
      !["succeeded", "recovered"].includes(before.outcome) &&
      capacityDigest(previous.active_candidate) !== capacityDigest(next.active_candidate)
    )
      throw new Error("unresolved capacity effects must retain actual reservation progress");
    return;
  }
  const active = next.active_candidate;
  if (
    !isRecord(active) ||
    capacityDigest(after.candidate) !==
      capacityDigest({
        source_commit: active.source_commit,
        prepared_commit: active.prepared_commit,
        version: active.version,
        transient_retries: active.transient_retries,
        substantive_repairs: active.substantive_repairs,
      })
  )
    throw new Error("capacity operation changed its frozen candidate");
  if (!before || before.id !== after.id) {
    for (const prior of retained) {
      if (
        !prior ||
        !isRecord(prior.candidate) ||
        !isRecord(after.candidate) ||
        prior.candidate.prepared_commit !== after.candidate.prepared_commit ||
        prior.kind !== after.kind ||
        prior.destination !== after.destination
      )
        continue;
      if (
        prior.outcome === "succeeded" ||
        (isRecord(prior.recovery) && prior.recovery.resolution === "effect-completed")
      )
        throw new Error("completed operation cannot be repeated");
      if (!["succeeded", "recovered"].includes(prior.outcome))
        throw new Error("new capacity operation cannot bypass unresolved historical effects");
      if (
        Number(after.candidate.transient_retries) <= Number(prior.candidate.transient_retries) &&
        Number(after.candidate.substantive_repairs) <= Number(prior.candidate.substantive_repairs)
      )
        throw new Error(
          "same-operation retry requires existing bounded coordinator recovery increment",
        );
    }
    if (before && !["succeeded", "recovered"].includes(before.outcome))
      throw new Error("new capacity operation cannot bypass unresolved effects");
    if (
      after.outcome !== "pending" ||
      after.completed_effects.length !== 0 ||
      after.before_checkpoint !== checkpoint ||
      after.sequence !== (before?.sequence ?? 0) + 1
    )
      throw new Error("capacity effect requires a preceding exact pending checkpoint");
    if (!isRecord(next.controller) || !isRecord(next.controller.capacity_attempt))
      throw new Error("capacity configuration missing");
    const readiness = assessBoundedCapacity({
      ...next.controller.capacity_attempt,
      operation: before,
    });
    if (
      readiness.eligibility !== "eligible" ||
      after.policy_sha256 !== readiness.resource_policy_sha256 ||
      after.ratification_sha256 !== readiness.ratification_sha256
    )
      throw new Error("capacity intent lacks bounded attempt eligibility");
    if (capacityDigest(previous.active_candidate) !== capacityDigest(next.active_candidate))
      throw new Error("pending capacity intent must retain actual reservation progress");
    return;
  }
  if (
    capacityDigest(before.completed_effects) !==
    capacityDigest(after.completed_effects.slice(0, before.completed_effects.length))
  )
    throw new Error("completed capacity effects regressed or changed");
  if (before.outcome === "succeeded" || before.outcome === "recovered") {
    if (capacityDigest(before) !== capacityDigest(after))
      throw new Error("completed capacity outcome cannot be rewritten");
  } else if (after.outcome === "recovered") {
    if (capacityDigest(before.failure_evidence) !== capacityDigest(after.failure_evidence))
      throw new Error("capacity recovery must preserve failure evidence");
    if (!isRecord(after.recovery) || after.recovery.checkpoint !== checkpoint)
      throw new Error("capacity recovery must bind its actual prior checkpoint");
  } else if (before.outcome !== "pending" && capacityDigest(before) !== capacityDigest(after))
    throw new Error("failed capacity outcome requires explicit readback recovery");
  // Recording outcomes must never rewind/advance the real reservation phase or
  // counters. The ordinary coordinator owns subsequent bounded recovery.
  if (capacityDigest(previous.active_candidate) !== capacityDigest(next.active_candidate))
    throw new Error("capacity outcome cannot rewrite actual reservation progress");
}
