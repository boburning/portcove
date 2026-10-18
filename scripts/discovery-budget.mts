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
export interface Usage {
  requests: number;
  bytes: number;
  started_at: string;
  profile: DiscoveryProfile;
  backoff_until?: string;
  attempts: { method: string; endpoint: string; status: string; requests: number; bytes: number }[];
}
export class DiscoveryBudget {
  readonly usage: Usage;
  readonly limits;
  reserve = { requests: 0, bytes: 0 };
  delivery = false;
  readonly persist: (usage: Usage) => void;
  readonly now: () => number;
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
      started_at: new Date(now()).toISOString(),
      profile,
      attempts: [],
    };
  }
  remaining() {
    return {
      requests:
        this.limits.requests - this.usage.requests - (this.delivery ? 0 : this.reserve.requests),
      bytes: this.limits.bytes - this.usage.bytes - (this.delivery ? 0 : this.reserve.bytes),
      milliseconds: this.limits.milliseconds - (this.now() - Date.parse(this.usage.started_at)),
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
      throw new Error("Provider backoff is active; resume after " + this.usage.backoff_until);
    if (left.milliseconds <= 0 || requests > left.requests || bytes > left.bytes)
      throw new Error("Discovery budget cannot admit the complete operation");
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
    this.usage.attempts.push({ method, endpoint, status, requests, bytes });
    this.persist(this.usage);
    if (this.usage.requests > this.limits.requests || this.usage.bytes > this.limits.bytes)
      throw new Error("Discovery hard budget exceeded");
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
  const request = (method: string, url: string, body?: string, binary = false) => {
    const left = budget.remaining();
    budget.admit(1, 1);
    const cap = Math.min(2 * 1024 * 1024, left.bytes);
    const maxRequests = Math.min(5, left.requests);
    const timeout = Math.min(20000, left.milliseconds);
    const response = spawnSync(process.execPath, [worker], {
      input: JSON.stringify({ method, url, body, binary, token, cap, maxRequests, timeout }),
      encoding: "utf8",
      windowsHide: true,
      timeout: timeout + 1000,
      maxBuffer: cap * 2 + 65536,
    });
    if (response.error || response.status !== 0) {
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
      budget.charge(
        method,
        new URL(url).origin + new URL(url).pathname,
        maxRequests,
        cap,
        "unknown",
      );
      throw new Error("Malformed bounded transport receipt; conservative charge");
    }
    budget.charge(
      method,
      new URL(url).origin + new URL(url).pathname,
      parsed.requests,
      parsed.bytes,
      String(parsed.status),
    );
    if (typeof parsed.backoff_until === "string") {
      budget.usage.backoff_until = parsed.backoff_until;
      budget.persist(budget.usage);
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
    const response = request(method, url.href, input);
    const included = `HTTP/2 ${response.status}\n${Object.entries(response.headers)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n")}\n\n${response.text}`;
    if (response.status >= 400)
      throw new GitHubApiError("http_error", `GitHub HTTP ${response.status}`, {
        status: response.status,
        rateLimit: rateLimitFromResponse(parseIncludedResponse(included)),
      });
    return included;
  };
  return { runner, request };
}
