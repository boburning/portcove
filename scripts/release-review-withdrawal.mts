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
