/** Discovery owns quota admission, accounting and recovery. The shared SDK owns
 * authenticated transport, byte collection, retry and cancellation mechanics. */
import { createGitHubClient } from "./github-client.mts";
import type { GitHubClientOptions, GitHubRequestPolicy } from "./github-client.mts";
import { GitHubApiError, sanitizeOperationError } from "./github-operation.mts";
import type { DiscoveryBudget } from "./discovery-budget.mts";
import { isRecord } from "./runtime-values.mts";

export function discoveryGitHubScope(
  budget: DiscoveryBudget,
  token: string,
  options: Pick<GitHubClientOptions, "fetch" | "signal"> = {},
): GitHubClientOptions & { failedReads: Map<string, GitHubRequestPolicy>; allowMutations: true } {
  if (!token)
    throw new GitHubApiError("credential_unavailable", "Explicit discovery credential is required");
  let probe = false;
  const scope: GitHubClientOptions & {
    failedReads: Map<string, GitHubRequestPolicy>;
    allowMutations: true;
  } = {
    ...options,
    credential: { kind: "explicit", token },
    deadline: budget.deadline,
    maxBytes: 2 * 1024 * 1024,
    headers: { accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    requestTimeoutMs: 20_000,
    deferral: budget.deferral,
    failedReads: new Map(),
    allowMutations: true,
    async reserve(request) {
      const graphql = request.url.pathname === "/graphql",
        quotaProbe = probe;
      if (quotaProbe) budget.admitQuotaProbe();
      else {
        await budget.admit(1, 1, request.signal);
        if (request.url.pathname !== "/rate_limit")
          await budget.admitProvider(
            graphql ? "graphql" : request.url.pathname.startsWith("/search/") ? "search" : "core",
            graphql ? budget.graphqlPointHeadroom : 1,
            false,
            source,
            request.signal,
          );
      }
      request.signal.throwIfAborted();
      let received = 0;
      return {
        consumeBytes(bytes) {
          received += bytes;
          if (received > budget.remaining().bytes)
            throw new GitHubApiError(
              "budget_exhausted",
              "Discovery metadata exceeds remaining operation bytes",
            );
        },
        settle(attempt) {
          budget.observations.push({
            operation: sanitizeOperationError(new Error(`${request.method} ${request.url.href}`), {
              secrets: [token],
            }).message.replace("https://api.github.com/", ""),
            status: attempt.status,
            request_id: attempt.headers["x-github-request-id"] ?? null,
            date: attempt.headers.date ?? null,
            bytes: attempt.bytes,
            bytes_known: !attempt.dispatched || attempt.status !== null || attempt.bytes > 0,
            elapsed_ms: attempt.elapsedMs,
            rate: attempt.rate ?? null,
            attempt: attempt.attempt,
            dispatched: attempt.dispatched,
          });
          if (!attempt.dispatched) return;
          if (graphql) budget.observeGraphqlCost(attempt.rate?.cost);
          budget.charge(
            request.method,
            request.url.origin + request.url.pathname,
            1,
            attempt.bytes,
            attempt.status === null ? "unknown" : String(attempt.status),
          );
          const rate = attempt.rate;
          if (
            !quotaProbe &&
            rate?.resource &&
            ["core", "graphql", "search"].includes(rate.resource) &&
            rate.remaining !== null &&
            rate.resetAt
          )
            budget.observeProvider(
              { resource: rate.resource, remaining: rate.remaining, resetAt: rate.resetAt },
              source,
            );
          const until = Math.max(budget.deferral.secondary, ...budget.deferral.primary.values());
          if (until > budget.now()) budget.retainBackoff(new Date(until).toISOString());
        },
      };
    },
    observe(attempt) {
      if (attempt.logicalRequest.admissionSettled)
        void budget.track(attempt.logicalRequest.admissionSettled);
    },
  };
  const source = budget.registerProvider(token, async (signal) => {
    await budget.refreshProvider(source, async () => {
      const sdk = await createGitHubClient({
        ...scope,
        maxBytes: 16384,
        ...(signal
          ? { signal: scope.signal ? AbortSignal.any([scope.signal, signal]) : signal }
          : {}),
      });
      probe = true;
      try {
        for (let observation = 0; observation < 2; observation++) {
          const response = await sdk.request("GET /rate_limit", {
            headers: {
              accept: "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28",
            },
            request: { portcove: { replay: "once", attempts: 0 } },
          });
          const data: unknown = response.data;
          if (!isRecord(data) || !isRecord(data.resources))
            throw new Error("Incomplete provider quota observation");
          const resources = data.resources;
          const quotas = ["core", "graphql", "search"].map((resource) => {
            const value = resources[resource];
            if (
              !isRecord(value) ||
              !Number.isSafeInteger(value.remaining) ||
              Number(value.remaining) < 0 ||
              !Number.isSafeInteger(value.limit) ||
              Number(value.limit) < Number(value.remaining) ||
              !Number.isSafeInteger(value.reset) ||
              Number(value.reset) <= 0 ||
              Number(value.reset) > 8_640_000_000_000
            )
              throw new Error("Incomplete provider quota observation");
            return {
              resource,
              remaining: Number(value.remaining),
              resetAt: new Date(Number(value.reset) * 1000).toISOString(),
            };
          });
          if (quotas.some((quota) => Date.parse(quota.resetAt) <= budget.now())) continue;
          for (const quota of quotas)
            budget.observeProvider(quota, source, quota.resource === "core");
          return;
        }
        throw new GitHubApiError(
          "quota_stale",
          "Provider quota observation remains stale after its bounded refresh",
        );
      } finally {
        probe = false;
      }
    });
  });
  return scope;
}
