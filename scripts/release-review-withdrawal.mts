import { releaseCanonicalDigest } from "./release-canonical.mts";
import { isRecord } from "./runtime-values.mts";

/** Bounded journal evidence, separate from any App Check. The protected
 * writer authenticates the owner grant, pause and terminal evidence. */
export function inspectReleaseReviewWithdrawal(raw: unknown) {
  if (raw == null) return null;
  if (
    !isRecord(raw) ||
    Object.keys(raw).sort().join(",") !==
      "approval_sha256,kind,request_checkpoint,request_id,schema_version,source_commit,source_tree,technical_stop_sha256" ||
    raw.schema_version !== 1 ||
    raw.kind !== "application-review-safety-withdrawal"
  )
    throw new Error("application review withdrawal shape differs");
  const digest = (value: unknown, length: number) => {
    if (typeof value !== "string" || value.length !== length || !/^[a-f0-9]+$/u.test(value))
      throw new Error("application review withdrawal identity absent");
    return value;
  };
  return {
    schema_version: 1 as const,
    kind: raw.kind,
    request_id: digest(raw.request_id, 64),
    source_commit: digest(raw.source_commit, 40),
    source_tree: digest(raw.source_tree, 40),
    request_checkpoint: digest(raw.request_checkpoint, 40),
    approval_sha256: digest(raw.approval_sha256, 64),
    technical_stop_sha256: digest(raw.technical_stop_sha256, 64),
  };
}

type ReviewWithdrawal = NonNullable<ReturnType<typeof inspectReleaseReviewWithdrawal>>;

/** The first receipt keeps its historical wire shape. Later checkpoints append
 * receipts in order under the same field. Appointments still carry one receipt. */
export function inspectRetainedReviewWithdrawals(raw: unknown): ReviewWithdrawal[] {
  if (!Array.isArray(raw)) {
    const withdrawal = inspectReleaseReviewWithdrawal(raw);
    return withdrawal ? [withdrawal] : [];
  }
  if (raw.length < 2 || raw.length > 32)
    throw new Error("retained application review withdrawal history is out of bounds");
  const sources = new Set<string>();
  const withdrawals: ReviewWithdrawal[] = [];
  for (const entry of raw as unknown[]) {
    const withdrawal = inspectReleaseReviewWithdrawal(entry);
    if (!withdrawal || sources.has(withdrawal.source_commit))
      throw new Error("retained application review withdrawal history has an invalid receipt");
    sources.add(withdrawal.source_commit);
    withdrawals.push(withdrawal);
  }
  return withdrawals;
}

export function appendRetainedReviewWithdrawal(raw: unknown, withdrawal: ReviewWithdrawal) {
  const previous = inspectRetainedReviewWithdrawals(raw);
  return previous.length === 0 ? withdrawal : [...previous, withdrawal];
}

export function matchesWithdrawnReviewRequest(
  withdrawal: NonNullable<ReturnType<typeof inspectReleaseReviewWithdrawal>>,
  request: { request_id: string; source_commit: string; source_tree: string } | null,
) {
  return (
    request?.request_id === withdrawal.request_id &&
    request.source_commit === withdrawal.source_commit &&
    request.source_tree === withdrawal.source_tree
  );
}

export function matchesRetainedReviewWithdrawal(
  withdrawal: NonNullable<ReturnType<typeof inspectReleaseReviewWithdrawal>>,
  input: Record<string, unknown>,
) {
  return (
    input.review_request === null &&
    inspectRetainedReviewWithdrawals(input.review_withdrawal).some(
      (retained) => releaseCanonicalDigest(retained) === releaseCanonicalDigest(withdrawal),
    )
  );
}
