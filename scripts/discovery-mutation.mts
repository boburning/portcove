import { GitHubApiError } from "./github-api.mts";
export interface DiscoveryMutation {
  status: string;
  created_issue?: number;
  created_comment?: number;
}
/** The rejection classification surrounds only the POST, never later readback. */
export function discoveryPost<T>(
  candidate: DiscoveryMutation,
  post: () => T,
  persist: () => void,
): T {
  candidate.status = "create-attempted";
  persist();
  try {
    return post();
  } catch (error) {
    if (
      error instanceof GitHubApiError &&
      error.status !== null &&
      [400, 401, 403, 404, 405, 410, 422, 429].includes(error.status) &&
      !candidate.created_issue &&
      !candidate.created_comment
    )
      candidate.status = "prepared";
    persist();
    throw error;
  }
}
export function recordDiscoveryComment(
  candidate: DiscoveryMutation,
  id: unknown,
  persist: () => void,
) {
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1)
    throw new Error("Comment POST identity is unknown; reconcile the material marker");
  if (candidate.created_comment && candidate.created_comment !== id)
    throw new Error("Comment marker identity changed; preserve and reconcile");
  candidate.created_comment = id;
  candidate.status = "created";
  persist();
}
export function assertDiscoveryCommentMayPost(candidate: DiscoveryMutation) {
  if (
    !["prepared", "needs-review", "reviewed"].includes(candidate.status) ||
    candidate.created_comment
  )
    throw new Error(
      "Unresolved comment response has no confirmed marker; retain for reconciliation without reposting",
    );
}
