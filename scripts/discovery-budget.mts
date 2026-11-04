import type { GitHubApiObservation } from "./github-operation.mts";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { GitHubApiError, sanitizeOperationError } from "./github-operation.mts";
import { isRecord } from "./runtime-values.mts";
import { isDiscoveryCache } from "./discovery-cache.mts";

export const discoveryProfiles = {
  ordinary: { requests: 200, bytes: 20 * 1024 * 1024, milliseconds: 30 * 60000 },
  cold: { requests: 300, bytes: 64 * 1024 * 1024, milliseconds: 30 * 60000 },
} as const;
export type DiscoveryProfile = keyof typeof discoveryProfiles;
// Planning headroom, not an atomic reservation or a bound on provider query cost.
const discoveryGraphqlPointHeadroom = 10;
interface ProviderQuota {
  resource: string;
  remaining: number;
  resetAt: string;
}
export interface Usage {
  requests: number;
  bytes: number;
  accounting_bytes: number;
  graphql_points_observed: number;
  graphql_cost_unknown_requests: number;
  started_at: string;
  profile: DiscoveryProfile;
  backoff_until?: string;
  provider_quotas?: Record<string, ProviderQuota>;
  provider_sources?: Record<string, Record<string, ProviderQuota>>;
  attempts: { method: string; endpoint: string; status: string; requests: number; bytes: number }[];
}
export class DiscoveryBudget {
  readonly usage: Usage;
  readonly observations: GitHubApiObservation[] = [];
  readonly limits;
  readonly deadline: number;
  readonly deferral = { primary: new Map<string, number>(), secondary: 0 };
  reserve = { requests: 0, bytes: 0 };
  delivery = false;
  readonly persist: (usage: Usage) => void;
  readonly now: () => number;
  graphqlPointHeadroom = discoveryGraphqlPointHeadroom;
  private readonly providers = new Map<
    string,
    { id: string; refresh: (signal?: AbortSignal) => void | Promise<void> }
  >();
  private readonly refreshAttempts = new Set<string>();
  private refreshing = false;
  private readonly pending = new Set<Promise<unknown>>();
  private cleanupFailures: unknown[] = [];
  track<T>(work: Promise<T>): Promise<T> {
    this.pending.add(work);
    void work.then(
      () => this.pending.delete(work),
      (error) => {
        this.pending.delete(work);
        this.cleanupFailures.push(error);
      },
    );
    return work;
  }
  async drain() {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
    const failures = this.cleanupFailures;
    this.cleanupFailures = [];
    return failures;
  }
  private coreObserved = false;
  registerProvider(token: string, refresh: (signal?: AbortSignal) => void | Promise<void>) {
    const existing = this.providers.get(token);
    if (existing) return existing.id;
    const id = `provider${this.providers.size + 1}`;
    const prior = this.providers.size === 0 ? this.usage.provider_quotas : undefined;
    this.providers.set(token, { id, refresh });
    this.usage.provider_sources ??= {};
    this.usage.provider_sources[id] = { ...prior };
    this.aggregateProviders();
    return id;
  }
  private aggregateProviders() {
    if (!this.providers.size) return;
    this.usage.provider_quotas ??= {};
    for (const resource of ["core", "graphql", "search"]) {
      const rows = [...this.providers.values()].map(
        (p) => this.usage.provider_sources?.[p.id]?.[resource],
      );
      if (rows.some((row) => !row)) {
        delete this.usage.provider_quotas[resource];
        continue;
      }
      const known = rows as ProviderQuota[];
      this.usage.provider_quotas[resource] = {
        resource,
        remaining: Math.min(...known.map((row) => row.remaining)),
        resetAt: known.map((row) => row.resetAt).toSorted()[0]!,
      };
    }
  }
  refreshProvider(id: string, action: () => void | Promise<void>) {
    return this.track(this.performRefresh(id, action));
  }
  private async performRefresh(id: string, action: () => void | Promise<void>) {
    const generation = `${id}:${JSON.stringify(
      Object.entries(this.usage.provider_sources?.[id] ?? {})
        .map(([key, value]) => [key, value.resetAt])
        .toSorted((a, b) =>
          String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0,
        ),
    )}`;
    if (this.refreshing || this.refreshAttempts.has(generation))
      throw new GitHubApiError(
        "quota_unknown",
        "Provider quota refresh cannot be retried in this window",
      );
    this.refreshing = true;
    try {
      this.admitQuotaProbe();
      this.refreshAttempts.add(generation);
      await action();
    } finally {
      this.refreshing = false;
    }
  }
  private async refreshExpired(resource: string, id?: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (this.refreshing) return;
    for (const provider of this.providers.values()) {
      if (id && provider.id !== id) continue;
      const quota = this.usage.provider_sources?.[provider.id]?.[resource];
      if (
        (quota && Date.parse(quota.resetAt) <= this.now()) ||
        (!quota && resource === "core" && this.coreObserved)
      )
        await provider.refresh(signal);
    }
  }
  admitQuotaProbe() {
    const left = this.remaining();
    if (
      !this.refreshing ||
      (!this.coreObserved && this.usage.requests >= this.limits.requests) ||
      left.bytes < 16384 ||
      left.milliseconds <= 0
    )
      throw new GitHubApiError(
        "budget_exhausted",
        "Quota observation cannot fit the existing byte/time budget",
      );
    this.checkBackoff();
    return { ...left, requests: 1, bytes: 16384 };
  }
  private checkBackoff() {
    if (this.usage.backoff_until && Date.parse(this.usage.backoff_until) > this.now())
      throw new GitHubApiError(
        "rate_limited",
        "Provider backoff is active; resume after " + this.usage.backoff_until,
      );
  }
  constructor(
    profile: DiscoveryProfile,
    persist: (usage: Usage) => void = () => {},
    now: () => number = Date.now,
    startedAt = new Date(now()).toISOString(),
  ) {
    this.persist = persist;
    this.now = now;
    this.limits = discoveryProfiles[profile];
    const started = Date.parse(startedAt);
    if (!Number.isFinite(started)) throw new Error("Invalid discovery start time");
    this.deadline = performance.now() + this.limits.milliseconds - Math.max(0, now() - started);
    this.usage = {
      requests: 0,
      bytes: 0,
      accounting_bytes: 0,
      graphql_points_observed: 0,
      graphql_cost_unknown_requests: 0,
      started_at: startedAt,
      profile,
      attempts: [],
    };
  }
  remaining() {
    const elapsed = this.now() - Date.parse(this.usage.started_at);
    const milliseconds = this.limits.milliseconds - elapsed;
    const quota = this.usage.provider_quotas?.core;
    // The historical request counts are bootstrap estimates, not throughput
    // ceilings once fresh provider capacity and actual costs are observable.
    // Keep the finite runtime and retained-byte envelopes for this batch.
    const adaptive = quota && Date.parse(quota.resetAt) > this.now() && this.usage.requests > 0;
    const requests = adaptive
      ? Math.max(
          0,
          Math.min(
            quota.remaining,
            Math.floor(milliseconds / Math.max(1, elapsed / this.usage.requests)),
            Math.floor(
              (this.limits.bytes - this.usage.bytes - this.usage.accounting_bytes) /
                Math.max(1, (this.usage.bytes + this.usage.accounting_bytes) / this.usage.requests),
            ),
          ),
        )
      : this.coreObserved && (!quota || Date.parse(quota.resetAt) <= this.now())
        ? 0
        : this.limits.requests - this.usage.requests;
    return {
      requests: requests - (this.delivery ? 0 : this.reserve.requests),
      bytes:
        this.limits.bytes -
        this.usage.bytes -
        this.usage.accounting_bytes -
        (this.delivery ? 0 : this.reserve.bytes),
      milliseconds,
    };
  }
  async admit(requests: number, bytes: number, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (
      !Number.isSafeInteger(requests) ||
      requests < 0 ||
      !Number.isSafeInteger(bytes) ||
      bytes < 0
    )
      throw new Error("Invalid operation budget");
    this.checkBackoff();
    await this.refreshExpired("core", undefined, signal);
    signal?.throwIfAborted();
    this.checkBackoff();
    const left = this.remaining();
    if (left.milliseconds <= 0 || requests > left.requests || bytes > left.bytes)
      throw new GitHubApiError(
        "budget_exhausted",
        "Discovery budget cannot admit the complete operation",
      );
  }
  async reserveDelivery(requests: number, bytes: number) {
    const previous = this.reserve;
    this.reserve = { requests: 0, bytes: 0 };
    try {
      await this.admit(requests, bytes);
      this.reserve = { requests, bytes };
    } catch (e) {
      this.reserve = previous;
      throw e;
    }
  }
  observeProvider(quota: ProviderQuota, source?: string, retainZero = true) {
    if (
      !["core", "graphql", "search"].includes(quota.resource) ||
      !Number.isSafeInteger(quota.remaining) ||
      quota.remaining < 0 ||
      !Number.isFinite(Date.parse(quota.resetAt))
    )
      throw new Error("Invalid provider quota observation");
    if (quota.resource === "core") this.coreObserved = true;
    const id = source ?? this.providers.values().next().value?.id;
    if (id) {
      if (!this.usage.provider_sources?.[id])
        throw new Error("Unknown provider observation source");
      this.usage.provider_sources[id][quota.resource] = quota;
      this.aggregateProviders();
    } else {
      this.usage.provider_quotas ??= {};
      this.usage.provider_quotas[quota.resource] = quota;
    }
    if (retainZero && quota.remaining === 0) this.retainBackoff(quota.resetAt);
    this.persist(this.usage);
  }
  retainBackoff(until: string) {
    if (!Number.isFinite(Date.parse(until))) throw new Error("Invalid provider backoff");
    if (
      Date.parse(until) > this.now() &&
      (!this.usage.backoff_until || Date.parse(until) > Date.parse(this.usage.backoff_until))
    )
      this.usage.backoff_until = until;
    this.persist(this.usage);
  }
  async admitProvider(
    resource: string,
    points: number,
    required = false,
    source?: string,
    signal?: AbortSignal,
  ) {
    await this.refreshExpired(resource, source, signal);
    signal?.throwIfAborted();
    const quota = source
      ? this.usage.provider_sources?.[source]?.[resource]
      : this.usage.provider_quotas?.[resource];
    if (!quota || Date.parse(quota.resetAt) <= this.now()) {
      if (required)
        throw new GitHubApiError(
          "quota_unknown",
          `GitHub ${resource} capacity unknown; refresh provider quota before delivery`,
        );
      return;
    }
    const reserve =
      this.delivery || resource === "search"
        ? 0
        : this.reserve.requests * (resource === "graphql" ? this.graphqlPointHeadroom : 1);
    if (quota.remaining < points + reserve)
      throw new GitHubApiError(
        "rate_limited",
        `GitHub ${resource} quota cannot preserve delivery reserve: remaining ${quota.remaining}, needed ${points + reserve}; resume after ${quota.resetAt}`,
      );
  }
  async requireProviderCapacity(requests: number) {
    await this.admitProvider("core", requests, true);
    await this.admitProvider("graphql", requests * this.graphqlPointHeadroom, true);
  }
  observeGraphqlCost(cost: unknown, unknownRequests = 1) {
    if (typeof cost === "number" && Number.isSafeInteger(cost) && cost >= 0) {
      this.usage.graphql_points_observed += cost;
      this.graphqlPointHeadroom = Math.max(this.graphqlPointHeadroom, cost);
    } else this.usage.graphql_cost_unknown_requests += unknownRequests;
    this.persist(this.usage);
  }
  charge(method: string, endpoint: string, requests: number, bytes: number, status: string) {
    if (
      !Number.isSafeInteger(requests) ||
      requests < 0 ||
      !Number.isSafeInteger(bytes) ||
      bytes < 0
    )
      throw new Error("Invalid discovery usage");
    this.usage.requests += requests;
    this.usage.bytes += bytes;
    // Conservatively charge all request chains to the observed core allowance.
    // An actual core response replaces this estimate with provider readback;
    // search/GraphQL retain their independent transport admission checks.
    const quota = this.usage.provider_quotas?.core;
    for (const rows of Object.values(this.usage.provider_sources ?? {}))
      if (rows.core) rows.core.remaining = Math.max(0, rows.core.remaining - requests);
    if (this.providers.size) this.aggregateProviders();
    else if (quota) quota.remaining = Math.max(0, quota.remaining - requests);
    const attempt = { method, endpoint, status, requests, bytes };
    this.usage.attempts.push(attempt);
    this.usage.accounting_bytes += Buffer.byteLength(JSON.stringify(attempt)) + 1;
    this.persist(this.usage);
    if (
      (!this.coreObserved && !this.refreshing && this.usage.requests > this.limits.requests) ||
      this.usage.bytes + this.usage.accounting_bytes > this.limits.bytes
    )
      throw new GitHubApiError("budget_exhausted", "Discovery hard budget exceeded");
  }
}
export function selectDiscoveryProfile(cache: unknown, now = Date.now()): DiscoveryProfile {
  if (
    !isRecord(cache) ||
    !isDiscoveryCache(cache) ||
    typeof cache.baseline_completed_at !== "string" ||
    !Number.isFinite(Date.parse(cache.baseline_completed_at)) ||
    Date.parse(cache.baseline_completed_at) > now ||
    now - Date.parse(cache.baseline_completed_at) >= 7 * 86400000
  )
    return "cold";
  return "ordinary";
}
/** Retained external/raw artifact reads only. GitHub metadata uses the SDK;
 * no CLI command protocol or included-HTTP emulation remains here. */
export function createDiscoveryTransport(
  budget: DiscoveryBudget,
  token: string,
  worker = fileURLToPath(new URL("./discovery-http.mts", import.meta.url)),
) {
  const request = async (method: string, url: string, body?: string, binary = false) => {
    const target = new URL(url);
    if (method !== "GET" || body !== undefined)
      throw new GitHubApiError(
        "request_refused",
        "Discovery external/byte transport admits reads only",
      );
    const github = target.origin === "https://api.github.com";
    if (
      github &&
      (!binary ||
        !/^\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/artifacts\/[1-9][0-9]*\/zip$/u.test(
          target.pathname,
        ))
    )
      throw new GitHubApiError("request_refused", "GitHub metadata must use the configured SDK");
    await budget.admit(1, 1);
    if (github) await budget.admitProvider("core", 1);
    const left = budget.remaining(),
      cap = Math.min(2 * 1024 * 1024, left.bytes);
    const maxRequests = Math.min(5, left.requests),
      timeout = Math.min(20000, left.milliseconds);
    const response = spawnSync(process.execPath, [worker], {
      input: JSON.stringify({ method, url, binary, token, cap, maxRequests, timeout }),
      encoding: "utf8",
      windowsHide: true,
      timeout: timeout + 1000,
      maxBuffer: cap * 2 + 65536,
    });
    const unknown = (message: string): never => {
      budget.charge(method, target.origin + target.pathname, maxRequests, cap, "unknown");
      throw new Error(message);
    };
    if (response.error || response.status !== 0)
      unknown("Bounded external/byte worker failed; usage conservatively charged");
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.stdout);
    } catch {
      unknown("Malformed external/byte receipt; usage conservatively charged");
    }
    if (
      !isRecord(parsed) ||
      !Number.isSafeInteger(parsed.requests) ||
      Number(parsed.requests) < 0 ||
      Number(parsed.requests) > maxRequests ||
      !Number.isSafeInteger(parsed.bytes) ||
      Number(parsed.bytes) < 0 ||
      !Number.isSafeInteger(parsed.status) ||
      !isRecord(parsed.headers) ||
      Object.values(parsed.headers).some((value) => typeof value !== "string") ||
      typeof parsed.text !== "string"
    )
      unknown("Malformed external/byte receipt; usage conservatively charged");
    // The runtime checks above establish every consumed worker field.
    const receipt = parsed as {
      requests: number;
      bytes: number;
      status: number;
      headers: Record<string, string>;
      text: string;
      backoff_until?: unknown;
      error?: unknown;
    };
    budget.charge(
      method,
      target.origin + target.pathname,
      receipt.requests,
      receipt.bytes,
      String(receipt.status),
    );
    if (github) {
      const remaining = Number(receipt.headers["x-ratelimit-remaining"]),
        reset = Number(receipt.headers["x-ratelimit-reset"]);
      if (
        receipt.headers["x-ratelimit-resource"] === "core" &&
        Number.isSafeInteger(remaining) &&
        remaining >= 0 &&
        Number.isSafeInteger(reset) &&
        reset >= 0 &&
        reset <= 8_640_000_000_000
      )
        budget.observeProvider({
          resource: "core",
          remaining,
          resetAt: new Date(reset * 1000).toISOString(),
        });
    }
    if (typeof receipt.backoff_until === "string") budget.retainBackoff(receipt.backoff_until);
    if (receipt.error)
      throw new GitHubApiError(
        "download_failed",
        sanitizeOperationError(
          new Error(typeof receipt.error === "string" ? receipt.error : "Bounded byte read failed"),
          { secrets: [token] },
        ).message,
        { status: receipt.status, responseBytes: receipt.bytes },
      );
    return {
      requests: receipt.requests,
      bytes: receipt.bytes,
      status: receipt.status,
      headers: receipt.headers,
      text: receipt.text,
    };
  };
  return { request };
}
