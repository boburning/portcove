import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { GitHubApiError, parseIncludedResponse, rateLimitFromResponse } from "./github-api.mts";
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
  attempts: { method: string; endpoint: string; status: string; requests: number; bytes: number }[];
}
export class DiscoveryBudget {
  readonly usage: Usage;
  readonly limits;
  reserve = { requests: 0, bytes: 0 };
  delivery = false;
  readonly persist: (usage: Usage) => void;
  readonly now: () => number;
  graphqlPointHeadroom = discoveryGraphqlPointHeadroom;
  constructor(
    profile: DiscoveryProfile,
    persist: (usage: Usage) => void = () => {},
    now: () => number = Date.now,
  ) {
    this.persist = persist;
    this.now = now;
    this.limits = discoveryProfiles[profile];
    this.usage = {
      requests: 0,
      bytes: 0,
      accounting_bytes: 0,
      graphql_points_observed: 0,
      graphql_cost_unknown_requests: 0,
      started_at: new Date(now()).toISOString(),
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
  admit(requests: number, bytes: number) {
    const left = this.remaining();
    if (
      !Number.isSafeInteger(requests) ||
      requests < 0 ||
      !Number.isSafeInteger(bytes) ||
      bytes < 0
    )
      throw new Error("Invalid operation budget");
    if (this.usage.backoff_until && Date.parse(this.usage.backoff_until) > this.now())
      throw new GitHubApiError(
        "rate_limited",
        "Provider backoff is active; resume after " + this.usage.backoff_until,
      );
    if (left.milliseconds <= 0 || requests > left.requests || bytes > left.bytes)
      throw new GitHubApiError(
        "budget_exhausted",
        "Discovery budget cannot admit the complete operation",
      );
  }
  reserveDelivery(requests: number, bytes: number) {
    const previous = this.reserve;
    this.reserve = { requests: 0, bytes: 0 };
    try {
      this.admit(requests, bytes);
      this.reserve = { requests, bytes };
    } catch (e) {
      this.reserve = previous;
      throw e;
    }
  }
  observeProvider(quota: ProviderQuota) {
    if (
      !["core", "graphql", "search"].includes(quota.resource) ||
      !Number.isSafeInteger(quota.remaining) ||
      quota.remaining < 0 ||
      !Number.isFinite(Date.parse(quota.resetAt))
    )
      throw new Error("Invalid provider quota observation");
    this.usage.provider_quotas ??= {};
    this.usage.provider_quotas[quota.resource] = quota;
    if (quota.remaining === 0) this.retainBackoff(quota.resetAt);
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
  admitProvider(resource: string, points: number, required = false) {
    const quota = this.usage.provider_quotas?.[resource];
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
  requireProviderCapacity(requests: number) {
    this.admitProvider("core", requests, true);
    this.admitProvider("graphql", requests * this.graphqlPointHeadroom, true);
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
    if (quota) quota.remaining = Math.max(0, quota.remaining - requests);
    const attempt = { method, endpoint, status, requests, bytes };
    this.usage.attempts.push(attempt);
    this.usage.accounting_bytes += Buffer.byteLength(JSON.stringify(attempt)) + 1;
    this.persist(this.usage);
    if (
      ((!quota || Date.parse(quota.resetAt) <= this.now()) &&
        this.usage.requests > this.limits.requests) ||
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
export function createDiscoveryTransport(
  budget: DiscoveryBudget,
  token: string,
  worker = fileURLToPath(new URL("./discovery-http.mts", import.meta.url)),
) {
  const request = (
    method: string,
    url: string,
    body?: string,
    binary = false,
    conditionalEtag?: string,
  ) => {
    const left = budget.remaining();
    budget.admit(1, 1);
    const target = new URL(url);
    if (target.origin === "https://api.github.com" && target.pathname !== "/rate_limit")
      budget.admitProvider(
        target.pathname === "/graphql"
          ? "graphql"
          : target.pathname.startsWith("/search/")
            ? "search"
            : "core",
        target.pathname === "/graphql" ? budget.graphqlPointHeadroom : 1,
      );
    const cap = Math.min(2 * 1024 * 1024, left.bytes);
    const maxRequests = Math.min(5, left.requests);
    const timeout = Math.min(20000, left.milliseconds);
    const response = spawnSync(process.execPath, [worker], {
      input: JSON.stringify({
        method,
        url,
        body,
        binary,
        token,
        cap,
        maxRequests,
        timeout,
        conditionalEtag,
      }),
      encoding: "utf8",
      windowsHide: true,
      timeout: timeout + 1000,
      maxBuffer: cap * 2 + 65536,
    });
    if (response.error || response.status !== 0) {
      if (target.origin === "https://api.github.com" && target.pathname === "/graphql")
        budget.observeGraphqlCost(undefined, maxRequests);
      budget.charge(
        method,
        new URL(url).origin + new URL(url).pathname,
        maxRequests,
        cap,
        "unknown",
      );
      throw new Error("Bounded HTTP worker failed; usage conservatively charged");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.stdout);
    } catch {
      if (target.origin === "https://api.github.com" && target.pathname === "/graphql")
        budget.observeGraphqlCost(undefined, maxRequests);
      budget.charge(
        method,
        new URL(url).origin + new URL(url).pathname,
        maxRequests,
        cap,
        "unknown",
      );
      throw new Error("Malformed bounded transport receipt; conservative charge");
    }
    if (
      !isRecord(parsed) ||
      typeof parsed.requests !== "number" ||
      !Number.isSafeInteger(parsed.requests) ||
      parsed.requests < 0 ||
      parsed.requests > maxRequests ||
      typeof parsed.bytes !== "number" ||
      !Number.isSafeInteger(parsed.bytes) ||
      parsed.bytes < 0 ||
      typeof parsed.status !== "number" ||
      !isRecord(parsed.headers) ||
      typeof parsed.text !== "string"
    ) {
      if (target.origin === "https://api.github.com" && target.pathname === "/graphql")
        budget.observeGraphqlCost(undefined, maxRequests);
      budget.charge(
        method,
        new URL(url).origin + new URL(url).pathname,
        maxRequests,
        cap,
        "unknown",
      );
      throw new Error("Malformed bounded transport receipt; conservative charge");
    }
    if (target.origin === "https://api.github.com" && target.pathname === "/graphql") {
      let cost: unknown;
      try {
        const body: unknown = JSON.parse(parsed.text);
        if (isRecord(body) && isRecord(body.data) && isRecord(body.data.rateLimit))
          cost = body.data.rateLimit.cost;
      } catch {
        /* Invalid JSON remains an invalid provider response; it establishes no cost. */
      }
      budget.observeGraphqlCost(cost);
      if (parsed.requests > 1) budget.observeGraphqlCost(undefined, parsed.requests - 1);
    }
    budget.charge(
      method,
      new URL(url).origin + new URL(url).pathname,
      parsed.requests,
      parsed.bytes,
      String(parsed.status),
    );
    const resource = parsed.headers["x-ratelimit-resource"];
    const remaining = parsed.headers["x-ratelimit-remaining"];
    const reset = parsed.headers["x-ratelimit-reset"];
    if (
      target.origin === "https://api.github.com" &&
      typeof resource === "string" &&
      ["core", "graphql", "search"].includes(resource) &&
      typeof remaining === "string" &&
      /^\d+$/u.test(remaining) &&
      typeof reset === "string" &&
      /^\d+$/u.test(reset)
    )
      budget.observeProvider({
        resource,
        remaining: Number(remaining),
        resetAt: new Date(Number(reset) * 1000).toISOString(),
      });
    if (typeof parsed.backoff_until === "string") {
      budget.retainBackoff(parsed.backoff_until);
    }
    if (parsed.error)
      throw new Error(typeof parsed.error === "string" ? parsed.error : "Bounded transport failed");
    return parsed as {
      requests: number;
      bytes: number;
      status: number;
      headers: Record<string, string>;
      text: string;
    };
  };
  const runner = (args: readonly string[], input?: string) => {
    if (args[0] === "auth" && args[1] === "status") return "";
    if (args[0] !== "api") throw new Error("Discovery requires bounded API commands");
    const graphql = args[1] === "graphql";
    const endpoint = graphql ? "graphql" : args[2];
    if (!endpoint) throw new Error("Missing API endpoint");
    const url = new URL(endpoint, "https://api.github.com/");
    if (url.origin !== "https://api.github.com") throw new Error("Unexpected GitHub API origin");
    const method = graphql ? "POST" : (args[args.indexOf("--method") + 1] ?? "GET");
    let etag: string | undefined;
    for (let index = 0; index < args.length; index++)
      if (args[index] === "--header") {
        const header = args[++index];
        if (!header?.startsWith("If-None-Match: ") || etag !== undefined)
          throw new Error("Discovery supports only one scoped conditional read header");
        etag = header.slice("If-None-Match: ".length);
      }
    const response = request(method, url.href, input, false, etag);
    const included = `HTTP/2 ${response.status}\n${Object.entries(response.headers)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n")}\n\n${response.text}`;
    if (response.status >= 400)
      throw new GitHubApiError("http_error", `GitHub HTTP ${response.status}`, {
        status: response.status,
        rateLimit: rateLimitFromResponse(parseIncludedResponse(included)),
        retryAfter: response.headers["retry-after"] ?? null,
        requestId: response.headers["x-github-request-id"] ?? null,
        responseDate: response.headers.date ?? null,
        responseBytes: Buffer.byteLength(response.text),
      });
    return included;
  };
  return { runner, request };
}
