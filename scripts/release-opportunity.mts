import { inspectPreviewWithdrawals } from "./release-preview-withdrawals.mts";

export function object(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
}

export function exactKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  object(value, label);
  const keys = new Set(Object.keys(value));
  for (const key of required) {
    if (!keys.delete(key)) throw new Error(`${label} is missing ${key}`);
  }
  for (const key of optional) keys.delete(key);
  if (keys.size) throw new Error(`${label} has unknown field ${[...keys].sort()[0]}`);
}

export function sha(value: unknown, label: string) {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/u.test(value))
    throw new Error(`${label} must be an exact lowercase commit identity`);
  return value;
}

export function boolean(value: unknown, label: string) {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

export function validateOpportunity(opportunity: unknown) {
  exactKeys(
    opportunity,
    [
      "source_commit",
      "source_tree",
      "base_commit",
      "change_set_sha256",
      "complete_change_set",
      "meaningful",
      "documentation_only",
      "urgency",
      "requested_channel",
      "classification",
    ],
    [],
    "release opportunity",
  );
  sha(opportunity.source_commit, "opportunity source commit");
  sha(opportunity.source_tree, "opportunity source tree");
  sha(opportunity.base_commit, "opportunity base commit");
  if (
    typeof opportunity.change_set_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(opportunity.change_set_sha256)
  )
    throw new Error("opportunity change-set digest is invalid");
  boolean(opportunity.complete_change_set, "complete change set");
  boolean(opportunity.meaningful, "meaningful change");
  boolean(opportunity.documentation_only, "documentation-only change");
  boolean(opportunity.urgency, "urgency");
  if (!opportunity.complete_change_set)
    throw new Error("release opportunity requires a complete accumulated change set");
  if (opportunity.requested_channel !== "preview" && opportunity.requested_channel !== "stable")
    throw new Error("requested channel must be preview or stable");
  object(opportunity.classification, "reviewed classification");
  if (opportunity.classification.preview_withdrawals !== undefined) {
    inspectPreviewWithdrawals(opportunity.classification.preview_withdrawals);
    if (opportunity.requested_channel !== "preview")
      throw new Error("Preview withdrawals cannot appoint Stable eligibility");
  }
  if (
    opportunity.classification.source_commit !== opportunity.source_commit ||
    opportunity.classification.reviewed_commit !== opportunity.source_commit ||
    opportunity.classification.source_tree !== opportunity.source_tree ||
    opportunity.classification.reviewed_tree !== opportunity.source_tree ||
    opportunity.classification.change_set_sha256 !== opportunity.change_set_sha256
  )
    throw new Error("reviewed classification is stale for the candidate identity");
  return {
    source_commit: sha(opportunity.source_commit, "opportunity source commit"),
    source_tree: sha(opportunity.source_tree, "opportunity source tree"),
    base_commit: sha(opportunity.base_commit, "opportunity base commit"),
    change_set_sha256: opportunity.change_set_sha256,
    complete_change_set: boolean(opportunity.complete_change_set, "complete change set"),
    meaningful: boolean(opportunity.meaningful, "meaningful change"),
    documentation_only: boolean(opportunity.documentation_only, "documentation-only change"),
    urgency: boolean(opportunity.urgency, "urgency"),
    requested_channel: opportunity.requested_channel,
    classification: opportunity.classification,
  };
}
