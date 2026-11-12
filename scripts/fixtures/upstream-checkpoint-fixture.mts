/** Synthetic catalog observer checkpoints for the maintenance upstream source. */
import { observationHash } from "../upstream-observer.mts";

export const facts = "f".repeat(64);
export const scope = "a".repeat(64);
export const exception = "e".repeat(64);
export const keyOf = (repository: string) => observationHash({ provider: "github", repository });

export const catalog = {
  ports: [
    { id: "alpha", channels: ["stable"], release: { repository: "owner/alpha" } },
    { id: "beta", channels: ["stable"], release: { repository: "owner/beta" } },
    { id: "gamma", channels: ["stable"], release: { repository: "owner/gamma" } },
    { id: "delta", channels: ["stable"], release: { provider: "sourceforge", repository: "x/y" } },
  ],
  listings: [],
};

export function progress(repository: string, ports: string[], overrides = {}) {
  return {
    provider: "github",
    repository,
    repository_id: 7,
    attempted_sequence: 3,
    completed_at: "2026-11-10T10:00:00.000Z",
    freshness_observed_at: "2026-11-10T10:00:00.000Z",
    last_change_at: "2026-11-01T00:00:00.000Z",
    change_intervals: 1,
    mean_change_interval_ms: 1000,
    next_due_at: "2026-11-10T16:00:00.000Z",
    result_sha256: "b".repeat(64),
    completed_scope_sha256: scope,
    last_complete_facts_sha256: facts,
    last_complete_policies: ports.map((port_id) => ({
      port_id,
      repository_id: 7,
      facts_sha256: facts,
      catalog_definition_sha256: "d".repeat(64),
      observed_at: "2026-11-10T10:00:00.000Z",
    })),
    retry_at: null,
    exception_key: null,
    exception_rule: null,
    selection_progress: null,
    policy_progress: null,
    current_config: null,
    last_complete_config: null,
    retired_configs: [],
    ...overrides,
  };
}

export function checkpoint(sources: Record<string, unknown>, sequence = 5) {
  return {
    format: 1,
    authority: "catalog-upstream-observation-only",
    sequence,
    provider_retry_at: null,
    sources,
  };
}
