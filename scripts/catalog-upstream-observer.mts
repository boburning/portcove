import { isRecord } from "./runtime-values.mts";
import {
  observationHash,
  ObservationFailure,
  validateObserverConfig,
} from "./upstream-observer.mts";
import type { ObserverConfig, ObserveOptions, ProviderObservation } from "./upstream-observer.mts";
import { advanceObservation } from "./observe-configured-upstream.mts";

export interface ObservablePort {
  id: string;
  channels: string[];
  definition_sha256: string;
  release: Record<string, unknown> & { repository: string };
}
export interface ObservableSource {
  key: string;
  repository: string;
  ports: ObservablePort[];
  scope_sha256: string;
}
interface SelectionProgress {
  binding: string;
  facts_sha256: string;
  cursor: number;
  release_ids: number[];
  sha256: string;
}
interface PolicyProgress {
  binding: string;
  facts_sha256: string;
  policies: Record<string, unknown>[];
  sha256: string;
}
export interface SourceProgress {
  repository: string;
  repository_id: number | null;
  attempted_sequence: number;
  completed_at: string | null;
  freshness_observed_at: string | null;
  last_change_at: string | null;
  change_intervals: number;
  mean_change_interval_ms: number | null;
  next_due_at: string | null;
  result_sha256: string | null;
  completed_scope_sha256: string | null;
  last_complete_facts_sha256: string | null;
  last_complete_policies: Record<string, unknown>[];
  retry_at: string | null;
  exception_key: string | null;
  selection_progress: SelectionProgress | null;
  policy_progress: PolicyProgress | null;
  current_config: ObserverConfig | null;
  last_complete_config: ObserverConfig | null;
  retired_configs: ObserverConfig[];
}
export interface CatalogObserverCheckpoint {
  format: 1;
  authority: "catalog-upstream-observation-only";
  sequence: number;
  provider_retry_at: string | null;
  sources: Record<string, SourceProgress>;
}
export const newCatalogObserverCheckpoint = (): CatalogObserverCheckpoint => ({
  format: 1,
  authority: "catalog-upstream-observation-only",
  sequence: 0,
  provider_retry_at: null,
  sources: {},
});

/** Reviewed catalog declarations are the only source of observation work. */
export function catalogObservationSources(input: unknown) {
  if (
    !isRecord(input) ||
    !Array.isArray(input.ports) ||
    Buffer.byteLength(JSON.stringify(input)) > 4 * 1024 * 1024
  )
    throw new Error("A bounded reviewed catalog is required");
  const seen = new Set<string>();
  const sources = new Map<string, ObservableSource>();
  const held: { port_id: string; reason: string; resume_condition: string }[] = [];
  for (const port of input.ports) {
    if (
      !isRecord(port) ||
      typeof port.id !== "string" ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(port.id) ||
      seen.has(port.id) ||
      !isRecord(port.release)
    )
      throw new Error("Catalog observation requires unique stable port identities");
    seen.add(port.id);
    const provider = port.release.provider ?? "github";
    if (typeof provider !== "string") throw new Error("Invalid reviewed release provider");
    if (provider !== "github") {
      held.push({
        port_id: port.id,
        reason: `provider-${String(provider)}-not-observable-by-core`,
        resume_condition:
          "A reviewed equivalent provider observation and Core policy capability must be delivered; no artifact eligibility is inferred.",
      });
      continue;
    }
    const repository = port.release.repository;
    if (
      typeof repository !== "string" ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository) ||
      !Array.isArray(port.channels) ||
      !port.channels.every((channel: unknown) =>
        ["stable", "beta", "rolling"].includes(String(channel)),
      )
    )
      throw new Error("Invalid reviewed GitHub observation declaration");
    const key = observationHash({ provider: "github", repository });
    const source = sources.get(key) ?? { key, repository, ports: [], scope_sha256: "" };
    source.ports.push({
      id: port.id,
      definition_sha256: observationHash(port),
      channels: port.channels.map((channel: unknown) => String(channel)),
      release: structuredClone(port.release) as ObservablePort["release"],
    });
    sources.set(key, source);
  }
  return {
    port_ids: [...seen],
    sources: [...sources.values()].map((source) => ({
      ...source,
      ports: source.ports.toSorted((a, b) => a.id.localeCompare(b.id)),
      scope_sha256: observationHash(
        source.ports
          .map((port) => ({ id: port.id, definition_sha256: port.definition_sha256 }))
          .toSorted((a, b) => a.id.localeCompare(b.id)),
      ),
    })),
    held,
  };
}

function progressCheckpoint(value: unknown, now: number): CatalogObserverCheckpoint {
  if (
    !isRecord(value) ||
    value.format !== 1 ||
    value.authority !== "catalog-upstream-observation-only" ||
    !Number.isSafeInteger(value.sequence) ||
    Number(value.sequence) < 0 ||
    (value.provider_retry_at !== null &&
      (typeof value.provider_retry_at !== "string" ||
        !Number.isFinite(Date.parse(value.provider_retry_at)))) ||
    !isRecord(value.sources) ||
    Buffer.byteLength(JSON.stringify(value)) > 32 * 1024 * 1024
  )
    throw new Error("Invalid catalog observer checkpoint");
  for (const [key, progress] of Object.entries(value.sources)) {
    if (
      !isRecord(progress) ||
      typeof progress.repository !== "string" ||
      key !== observationHash({ provider: "github", repository: progress.repository }) ||
      (progress.repository_id !== null &&
        (!Number.isSafeInteger(progress.repository_id) || Number(progress.repository_id) <= 0)) ||
      !Number.isSafeInteger(progress.attempted_sequence) ||
      Number(progress.attempted_sequence) < 0 ||
      Number(progress.attempted_sequence) > Number(value.sequence) ||
      [
        progress.completed_at,
        progress.freshness_observed_at,
        progress.last_change_at,
        progress.next_due_at,
        progress.retry_at,
      ].some(
        (clock) =>
          clock !== null && (typeof clock !== "string" || !Number.isFinite(Date.parse(clock))),
      ) ||
      [
        progress.completed_scope_sha256,
        progress.last_complete_facts_sha256,
        progress.exception_key,
      ].some(
        (value) => value !== null && (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)),
      ) ||
      !Number.isSafeInteger(progress.change_intervals) ||
      Number(progress.change_intervals) < 0 ||
      (progress.mean_change_interval_ms !== null &&
        (typeof progress.mean_change_interval_ms !== "number" ||
          !Number.isFinite(progress.mean_change_interval_ms) ||
          progress.mean_change_interval_ms <= 0)) ||
      [progress.completed_at, progress.freshness_observed_at, progress.last_change_at].some(
        (clock) => typeof clock === "string" && Date.parse(clock) > now,
      ) ||
      !Array.isArray(progress.last_complete_policies) ||
      progress.last_complete_policies.some(
        (policy: unknown) =>
          !isRecord(policy) ||
          policy.repository_id !== progress.repository_id ||
          policy.facts_sha256 !== progress.last_complete_facts_sha256 ||
          typeof policy.port_id !== "string",
      ) ||
      (progress.result_sha256 !== null &&
        (typeof progress.result_sha256 !== "string" ||
          !/^[a-f0-9]{64}$/u.test(progress.result_sha256)))
    )
      throw new Error("Invalid catalog source identity or progress");
  }
  for (const raw of Object.values(value.sources)) {
    if (!isRecord(raw)) throw new Error("Invalid source progress");
    if (!Array.isArray(raw.retired_configs))
      throw new Error("Invalid retired observer configurations");
    const retiredConfigurations: unknown[] = raw.retired_configs;
    const configurations: unknown[] = [
      ...retiredConfigurations,
      ...(raw.current_config === null ? [] : [raw.current_config]),
      ...(raw.last_complete_config === null ? [] : [raw.last_complete_config]),
    ];
    for (const configuration of configurations) {
      const config = validateObserverConfig(configuration);
      if (config.repository !== raw.repository || config.repository_id !== raw.repository_id)
        throw new Error("Retained observer configuration escaped its source identity");
    }
    for (const key of ["selection_progress", "policy_progress"] as const) {
      const progress = raw[key];
      if (progress === null) continue;
      if (
        !isRecord(progress) ||
        ![progress.binding, progress.facts_sha256, progress.sha256].every(
          (value) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value),
        )
      )
        throw new Error("Invalid Core continuation binding");
      if (key === "selection_progress") {
        if (
          !Number.isSafeInteger(progress.cursor) ||
          Number(progress.cursor) < 0 ||
          !Array.isArray(progress.release_ids) ||
          progress.release_ids.some(
            (id: unknown) => !Number.isSafeInteger(id) || Number(id) <= 0,
          ) ||
          new Set(progress.release_ids).size !== progress.release_ids.length ||
          progress.sha256 !== observationHash(progress.release_ids)
        )
          throw new Error("Invalid Core selection continuation");
      } else if (
        !Array.isArray(progress.policies) ||
        progress.policies.some((policy: unknown) => !isRecord(policy)) ||
        progress.sha256 !== observationHash(progress.policies)
      )
        throw new Error("Invalid Core policy continuation");
    }
  }
  return structuredClone(value) as unknown as CatalogObserverCheckpoint;
}

type SourceResult = Awaited<ReturnType<typeof advanceObservation>>;
export interface CatalogObservationOptions extends Pick<
  ObserveOptions,
  "fetch" | "signal" | "sleep" | "token"
> {
  now?: () => number;
  config: ObserverConfig;
  policyIdentity: string;
  withSourceLock: <T>(config: ObserverConfig, operation: () => Promise<T>) => Promise<T>;
  load: (config: ObserverConfig) => Promise<unknown>;
  save: (config: ObserverConfig, checkpoint: unknown) => Promise<void>;
  commit: (checkpoint: CatalogObserverCheckpoint) => Promise<void>;
  repositoryId: (
    source: ObservableSource,
    transport: Required<
      Pick<ObserveOptions, "admitRequest" | "observeResponse" | "consumeResponseBytes">
    >,
  ) => Promise<number>;
  project: (
    portId: string,
    repositoryId: number,
    observation: ProviderObservation,
  ) => Promise<unknown>;
  export: (
    source: ObservableSource,
    config: ObserverConfig,
    result: SourceResult,
    policies: unknown[],
  ) => Promise<void>;
}

/** Finite shared runtime/quota, fair durable source turns, existing per-source continuation. */
export async function advanceCatalogObservations(
  catalog: unknown,
  prior: unknown,
  options: CatalogObservationOptions,
) {
  const { sources, held, port_ids: catalogIds } = catalogObservationSources(catalog);
  const now = options.now ?? Date.now;
  const state = prior === null ? newCatalogObserverCheckpoint() : progressCheckpoint(prior, now());
  if (state.provider_retry_at && Date.parse(state.provider_retry_at) <= now())
    state.provider_retry_at = null;
  const template = validateObserverConfig(options.config);
  if (!/^[a-f0-9]{64}$/u.test(options.policyIdentity))
    throw new Error("Exact Core policy input identity is required");
  const deadline = now() + template.budget.duration_ms;
  const scopeBinding = (source: ObservableSource) =>
    observationHash({ policy: options.policyIdentity, scope: source.scope_sha256 });
  let requests = 0;
  let responseBytes = 0;
  let unknownSizeResponses = 0;
  let notifyException = false;
  let requestStartedAt = now();
  let sampledCostMs = 0;
  let sampledRequests = 0;
  let remaining: number | null = null;
  let resetAt: number | null = null;
  let providerLimit: number | null = null;
  const consumeResponseBytes = (bytes: number | null) => {
    if (bytes !== null && (!Number.isSafeInteger(bytes) || bytes < 0))
      throw new ObservationFailure("invalid-metadata", "Provider response size is invalid");
    if (bytes === null) unknownSizeResponses++;
    responseBytes += bytes ?? template.budget.response_bytes;
    if (responseBytes > template.budget.total_bytes)
      throw new ObservationFailure("budget", "Shared response byte envelope exhausted");
  };
  const observeResponse = (response: Response) => {
    sampledCostMs += Math.max(1, now() - requestStartedAt);
    sampledRequests++;
    const integer = (name: string) => {
      const raw = response.headers.get(name);
      return raw !== null && /^\d+$/u.test(raw) && Number.isSafeInteger(Number(raw))
        ? Number(raw)
        : null;
    };
    const available = integer("x-ratelimit-remaining");
    const limit = integer("x-ratelimit-limit");
    const reset = integer("x-ratelimit-reset");
    if (available !== null && limit !== null && available <= limit) {
      remaining = available;
      providerLimit = limit;
      resetAt = reset === null || reset * 1000 > 8.64e15 ? null : reset * 1000;
    }
  };
  const attempted: string[] = [];
  const completed: string[] = [];
  const failures: { source: string; rule: string }[] = [];
  const pending = sources
    .filter((source) => {
      const progress = state.sources[source.key];
      return (
        !progress ||
        ((progress.completed_scope_sha256 !== scopeBinding(source) ||
          source.repository === template.repository ||
          !progress.next_due_at ||
          Date.parse(progress.next_due_at) <= now()) &&
          (!progress.retry_at || Date.parse(progress.retry_at) <= now()))
      );
    })
    .sort(
      (a, b) =>
        (state.sources[a.key]?.attempted_sequence ?? state.sequence) -
          (state.sources[b.key]?.attempted_sequence ?? state.sequence) ||
        a.key.localeCompare(b.key),
    );
  const capacity = () =>
    state.provider_retry_at && Date.parse(state.provider_retry_at) > now()
      ? 0
      : Math.max(
          0,
          Math.min(
            remaining === null
              ? template.budget.requests - requests
              : remaining - Math.max(1, Math.ceil((providerLimit ?? remaining) * 0.05)),
            Math.floor(
              (deadline - now()) /
                (sampledRequests
                  ? sampledCostMs / sampledRequests
                  : template.budget.duration_ms / template.budget.requests),
            ),
          ),
        );
  const admitRequest = () => {
    if (options.signal?.aborted)
      throw new ObservationFailure("cancelled", "Observation cancelled before provider admission");
    const providerDepleted =
      remaining !== null &&
      remaining <= Math.max(1, Math.ceil((providerLimit ?? remaining) * 0.05));
    if (providerDepleted && resetAt !== null)
      state.provider_retry_at = new Date(resetAt).toISOString();
    if (now() >= deadline || capacity() < 1)
      throw new ObservationFailure(
        "budget",
        "Shared provider reserve or runtime exhausted",
        providerDepleted && resetAt !== null ? new Date(resetAt).toISOString() : null,
      );
    requestStartedAt = now();
    requests++;
    if (remaining !== null) remaining--;
  };
  const projectBound = async (
    portId: string,
    repositoryId: number,
    observation: ProviderObservation,
  ) => {
    if (options.signal?.aborted)
      throw new ObservationFailure("cancelled", "Observation cancelled before Core projection");
    if (now() >= deadline)
      throw new ObservationFailure(
        "budget",
        "Core projection admission exhausted; retain completed projections",
      );
    const policy = await options.project(portId, repositoryId, observation);
    if (
      !isRecord(policy) ||
      policy.format !== 1 ||
      policy.port_id !== portId ||
      policy.repository_id !== repositoryId ||
      policy.facts_sha256 !== observation.facts_sha256 ||
      !Array.isArray(policy.projections)
    )
      throw new ObservationFailure(
        "core-binding",
        "Core projection differs from the exact port, source or provider facts",
      );
    return policy;
  };
  for (const [index, source] of pending.entries()) {
    if (
      options.signal?.aborted ||
      now() >= deadline ||
      responseBytes >= template.budget.total_bytes
    )
      break;
    // Completed provider reads may still admit offline Core continuation while the provider is unavailable.
    if (capacity() < 1 && !state.sources[source.key]?.policy_progress) continue;
    const progress = state.sources[source.key] ?? {
      repository: source.repository,
      repository_id: null,
      attempted_sequence: 0,
      completed_at: null,
      freshness_observed_at: null,
      last_change_at: null,
      change_intervals: 0,
      mean_change_interval_ms: null,
      next_due_at: null,
      result_sha256: null,
      completed_scope_sha256: null,
      last_complete_facts_sha256: null,
      last_complete_policies: [],
      retry_at: null,
      exception_key: null,
      selection_progress: null,
      policy_progress: null,
      current_config: null,
      last_complete_config: null,
      retired_configs: [],
    };
    if (state.sequence >= Number.MAX_SAFE_INTEGER)
      throw new Error("Source scheduling sequence exhausted");
    progress.attempted_sequence = ++state.sequence;
    state.sources[source.key] = progress;
    await options.commit(structuredClone(state));
    attempted.push(source.key);
    try {
      const legacy =
        source.repository === template.repository &&
        source.ports.some((port) => port.id === template.port_id);
      if (
        legacy &&
        progress.repository_id !== null &&
        progress.repository_id !== template.repository_id
      )
        throw new ObservationFailure(
          "repository-identity",
          "Retained repository identity conflicts with the reviewed configured source",
        );
      if (progress.repository_id === null) {
        const identity = legacy
          ? template.repository_id
          : await options.repositoryId(source, {
              admitRequest,
              observeResponse,
              consumeResponseBytes,
            });
        if (!Number.isSafeInteger(identity) || identity <= 0)
          throw new ObservationFailure(
            "repository-identity",
            "Provider repository identity is unavailable",
          );
        progress.repository_id = identity;
        await options.commit(structuredClone(state));
      }
      const config: ObserverConfig = legacy
        ? template
        : validateObserverConfig({
            ...template,
            format: 2,
            port_id: source.ports[0]!.id,
            repository: source.repository,
            repository_id: progress.repository_id,
            asset_scope: "core-channel-candidates",
            policy_input_sha256: observationHash(
              source.ports.map((port) => ({
                id: port.id,
                channels: port.channels,
                rolling_tag: port.release.rolling_tag ?? null,
              })),
            ),
          });
      if (
        progress.current_config &&
        observationHash(progress.current_config) !== observationHash(config)
      )
        progress.retired_configs.push(progress.current_config);
      progress.current_config = config;
      await options.commit(structuredClone(state));
      const policies: unknown[] = [];
      const scoped = (observation: ProviderObservation, portId: string) => ({
        ...observation,
        port_id: portId,
      });
      let coreProgress = 0;
      const binding = scopeBinding(source);
      const projectAll = async (observation: ProviderObservation) => {
        if (
          progress.policy_progress?.binding !== binding ||
          progress.policy_progress.facts_sha256 !== observation.facts_sha256
        )
          progress.policy_progress = {
            binding,
            facts_sha256: observation.facts_sha256,
            policies: [],
            sha256: observationHash([]),
          };
        const pendingPolicies = progress.policy_progress;
        if (
          pendingPolicies.policies.length > source.ports.length ||
          pendingPolicies.sha256 !== observationHash(pendingPolicies.policies) ||
          pendingPolicies.policies.some(
            (policy, index) =>
              policy.port_id !== source.ports[index]?.id ||
              policy.repository_id !== config.repository_id ||
              policy.facts_sha256 !== observation.facts_sha256,
          )
        )
          throw new ObservationFailure(
            "invalid-checkpoint",
            "Continued Core projections differ from exact policy, port order or facts",
          );
        for (let index = pendingPolicies.policies.length; index < source.ports.length; index++) {
          const port = source.ports[index]!;
          pendingPolicies.policies.push(
            await projectBound(port.id, config.repository_id, scoped(observation, port.id)),
          );
          pendingPolicies.sha256 = observationHash(pendingPolicies.policies);
          await options.commit(structuredClone(state));
          coreProgress++;
        }
        policies.push(...pendingPolicies.policies);
        return policies[source.ports.findIndex((port) => port.id === config.port_id)];
      };
      let sourceRequests = 0;
      const quantum = Math.max(
        1,
        Math.min(template.budget.requests, Math.floor(capacity() / (pending.length - index))),
      );
      const result = await options.withSourceLock(config, async () => {
        const priorSource = await options.load(config);
        const result = await advanceObservation(config, priorSource, {
          ...(options.fetch ? { fetch: options.fetch } : {}),
          ...(options.token ? { token: options.token } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.sleep ? { sleep: options.sleep } : {}),
          now,
          catalogIds,
          admitRequest: () => {
            if (sourceRequests >= quantum)
              throw new ObservationFailure(
                "budget",
                "Fair source batch admission exhausted; continue after other admitted source turns",
                null,
              );
            admitRequest();
            sourceRequests++;
          },
          observeResponse,
          consumeResponseBytes,
          selectAssetReleases: async (headers) => {
            if (
              progress.selection_progress?.binding !== binding ||
              progress.selection_progress.facts_sha256 !== headers.facts_sha256
            )
              progress.selection_progress = {
                binding,
                facts_sha256: headers.facts_sha256,
                cursor: 0,
                release_ids: [],
                sha256: observationHash([]),
              };
            const selection = progress.selection_progress;
            if (
              selection.cursor > source.ports.length ||
              selection.sha256 !== observationHash(selection.release_ids) ||
              selection.release_ids.some(
                (id) => !headers.facts.releases.some((release) => release.id === id),
              )
            )
              throw new ObservationFailure(
                "invalid-checkpoint",
                "Continued Core selection differs from exact policy or release headers",
              );
            const candidates = new Set(selection.release_ids);
            for (let index = selection.cursor; index < source.ports.length; index++) {
              const port = source.ports[index]!;
              const policy = await projectBound(
                port.id,
                config.repository_id,
                scoped(headers, port.id),
              );
              for (const projection of policy.projections as unknown[]) {
                if (
                  isRecord(projection) &&
                  port.channels.includes(String(projection.channel)) &&
                  isRecord(projection.channel_candidate) &&
                  Number.isSafeInteger(projection.channel_candidate.id)
                )
                  candidates.add(Number(projection.channel_candidate.id));
              }
              selection.release_ids = [...candidates].sort((a, b) => a - b);
              selection.sha256 = observationHash(selection.release_ids);
              selection.cursor = index + 1;
              await options.commit(structuredClone(state));
              coreProgress++;
            }
            return selection.release_ids;
          },
          project: projectAll,
          commitContinuation: (checkpoint) => options.save(config, checkpoint),
        });
        await options.save(config, result.checkpoint);
        // Historical projections retain their own facts/definition identities.
        // A changed configuration may have no current observation at all.
        const fallback = progress.last_complete_policies;
        await options.export(source, config, result, result.report.exception ? fallback : policies);
        return result;
      });
      if (result.report.exception) {
        if (
          result.report.exception.rule === "budget" &&
          (sourceRequests > 0 || coreProgress > 0) &&
          result.checkpoint.continuation &&
          capacity() > 0 &&
          now() < deadline
        )
          pending.push(source);
        if (
          result.notify_exception &&
          !["budget", "cancelled"].includes(result.report.exception.rule)
        )
          notifyException = true;
        progress.exception_key = result.report.exception.key;
        progress.retry_at = result.report.exception.retry_at;
        if (result.report.exception.rule === "rate-limit") {
          remaining = 0;
          state.provider_retry_at = result.report.exception.retry_at;
        }
        failures.push({ source: source.key, rule: result.report.exception.rule });
      } else {
        const sameScope = progress.completed_scope_sha256 === binding;
        const changed =
          sameScope &&
          progress.last_complete_facts_sha256 !== result.report.observation?.facts_sha256;
        if (!sameScope) {
          progress.last_change_at = new Date(now()).toISOString();
          progress.change_intervals = 0;
          progress.mean_change_interval_ms = null;
        }
        if (changed) {
          if (
            progress.last_change_at &&
            now() > Date.parse(progress.last_change_at) &&
            progress.change_intervals < Number.MAX_SAFE_INTEGER
          ) {
            const interval = now() - Date.parse(progress.last_change_at);
            progress.change_intervals++;
            progress.mean_change_interval_ms =
              (progress.mean_change_interval_ms ?? interval) +
              (interval - (progress.mean_change_interval_ms ?? interval)) /
                progress.change_intervals;
          }
          progress.last_change_at = new Date(now()).toISOString();
        }
        progress.completed_at = result.report.last_complete_at;
        progress.next_due_at = result.report.next_observation_due_at;
        progress.freshness_observed_at = result.report.freshness_observed_at;
        if (
          progress.mean_change_interval_ms &&
          progress.freshness_observed_at &&
          source.repository !== template.repository
        ) {
          const staleDeadline =
            Date.parse(progress.freshness_observed_at) +
            template.stale_after_hours * 3600000 -
            template.budget.duration_ms;
          const predicted =
            Date.parse(progress.completed_at!) +
            Math.max(template.cadence_hours * 3600000, progress.mean_change_interval_ms / 2);
          progress.next_due_at = new Date(
            Math.max(now(), Math.min(staleDeadline, predicted)),
          ).toISOString();
        }
        progress.retry_at = null;
        progress.exception_key = null;
        // Coverage and current Core output can change eligibility without changing provider facts.
        progress.completed_scope_sha256 = binding;
        progress.last_complete_config = config;
        progress.last_complete_facts_sha256 = result.report.observation?.facts_sha256 ?? null;
        progress.policy_progress = null;
        progress.last_complete_policies = policies.map((policy) => {
          if (!isRecord(policy)) throw new Error("Missing complete Core projection");
          return structuredClone(policy);
        });
        progress.result_sha256 = observationHash({
          facts_sha256: result.report.observation?.facts_sha256,
          coverage: result.report.observation?.coverage ?? null,
          policies: policies.map((policy) => {
            if (!isRecord(policy)) throw new Error("Missing policy output");
            const { observed_at: _clock, ...semantic } = policy;
            return semantic;
          }),
        });
        completed.push(source.key);
      }
    } catch (error) {
      progress.retry_at = error instanceof ObservationFailure ? error.retryAt : null;
      if (error instanceof ObservationFailure && error.rule === "rate-limit") {
        remaining = 0;
        state.provider_retry_at = error.retryAt;
      }
      const rule = error instanceof ObservationFailure ? error.rule : "source-operation-failed";
      const key = observationHash({ source: source.key, rule });
      if (progress.exception_key !== key && !["budget", "cancelled"].includes(rule))
        notifyException = true;
      progress.exception_key = key;
      failures.push({ source: source.key, rule });
    }
    await options.commit(structuredClone(state));
  }
  return {
    checkpoint: state,
    notify_exception: notifyException,
    report: {
      format: 1,
      authority: "catalog-upstream-observation-only",
      generated_at: new Date(now()).toISOString(),
      total_sources: sources.length,
      source_statuses: sources.map((source) => {
        const progress = state.sources[source.key];
        return {
          repository: source.repository,
          port_ids: source.ports.map((port) => port.id),
          current_scope_complete:
            progress?.completed_scope_sha256 === scopeBinding(source) &&
            progress.exception_key === null,
          observed_at: progress?.freshness_observed_at ?? null,
          stale:
            !progress?.freshness_observed_at ||
            now() - Date.parse(progress.freshness_observed_at) >
              template.stale_after_hours * 3600000,
          retry_at: progress?.retry_at ?? null,
          next_due_at: progress?.next_due_at ?? null,
        };
      }),
      attempted_source_keys: attempted,
      completed_source_keys: completed,
      pending_source_keys: sources
        .filter(
          (source) =>
            state.sources[source.key]?.completed_scope_sha256 !== scopeBinding(source) ||
            !state.sources[source.key]?.completed_at ||
            !state.sources[source.key]?.next_due_at ||
            Date.parse(state.sources[source.key]!.next_due_at!) <= now(),
        )
        .map((source) => source.key),
      held,
      failures,
      requests,
      request_accounting:
        "admitted transport attempts; internal GitHub CLI requests and actual provider charges may differ",
      provider_capacity: state.provider_retry_at
        ? { availability: "unavailable-until-reset", retry_at: state.provider_retry_at }
        : { availability: remaining === null ? "unknown" : "observed", remaining },
      response_bytes_charged: responseBytes,
      unknown_response_size_requests: unknownSizeResponses,
      global_eligibility: "not-assessed",
      protected_publication: "not-authorized",
    },
  };
}
