import { Octokit } from "@octokit/core";
import { composePaginateRest } from "@octokit/plugin-paginate-rest";
import {
  GitHubApiError,
  sanitizeOperationError,
  rateLimitFromResponse,
} from "./github-operation.mts";
import { isRecord } from "./runtime-values.mts";
import type { GitHubRateLimit } from "./github-operation.mts";

export type GitHubCredential =
  | { kind: "anonymous" }
  | { kind: "explicit"; token: string }
  | { kind: "local"; resolve: (signal: AbortSignal) => Promise<string> };

/** Reuse this object when recovering the same logical read; stability reads
 * receive a new object. No URL-keyed or process-global retry ledger exists. */
export interface GitHubRequestPolicy {
  replay: "safe-read" | "pure-query" | "once";
  attempts: number;
  deadline?: number;
  secondaryFailures?: number;
  /** An aborted admission may still own cleanup; command owners join this before terminal evidence. */
  admissionSettled?: Promise<void>;
  reserve?: GitHubClientOptions["reserve"];
}
export interface GitHubAttemptObservation {
  attempt: number;
  dispatched: boolean;
  bytes: number;
  elapsedMs: number;
  status: number | null;
  headers: Readonly<Record<string, string>>;
  logicalRequest: GitHubRequestPolicy;
  rate?: GitHubRateLimit;
}
export interface GitHubDeferralState {
  primary: Map<string, number>;
  secondary: number;
}
export interface GitHubClientOptions {
  credential: GitHubCredential;
  /** Monotonic, operation-wide deadline, never renewed by retries. */
  deadline: number;
  signal?: AbortSignal;
  maxBytes?: number;
  headers?: Readonly<Record<string, string>>;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  wallNow?: () => number;
  requestTimeoutMs?: number;
  deferral?: GitHubDeferralState;
  random?: () => number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  allowRequest?: (method: string, url: URL) => boolean;
  /** Existing domain accounting reserves before dispatch and settles every
   * outcome, including local refusal and cancellation after send. */
  reserve?: (request: {
    method: string;
    url: URL;
    replay: GitHubRequestPolicy["replay"];
    signal: AbortSignal;
  }) => GitHubReservation | Promise<GitHubReservation>;
  observe?: (observation: GitHubAttemptObservation) => void;
}

export interface GitHubReservation {
  consumeBytes: (bytes: number) => void;
  settle: (observation: GitHubAttemptObservation) => void;
}

const transientStatuses = new Set([408, 500, 502, 503, 504]);
const transientCauses = new Set(["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ECONNREFUSED"]);

/** Reject values that cannot pass through existing JSON/hash contracts exactly. */
function requireJsonValues(value: unknown) {
  const pending: unknown[] = [value];
  while (pending.length) {
    const next = pending.pop();
    if (
      typeof next === "bigint" ||
      (typeof next === "number" &&
        (!Number.isFinite(next) || (Number.isInteger(next) && !Number.isSafeInteger(next))))
    )
      throw new GitHubApiError("invalid_response", "GitHub returned an unsupported numeric value");
    if (Array.isArray(next)) pending.push(...(next as unknown[]));
    else if (isRecord(next)) pending.push(...Object.values(next));
  }
}

/** One neutral factory. No ambient credentials, domain imports, cache, inventory
 * interpretation or SDK retry/throttling plugin is installed here. */
export async function createGitHubClient(options: GitHubClientOptions) {
  const now = options.now ?? (() => performance.now());
  const wallNow = options.wallNow ?? Date.now;
  const deferral = options.deferral ?? { primary: new Map<string, number>(), secondary: 0 };
  const requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
  const maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    !Number.isFinite(options.deadline) ||
    !Number.isSafeInteger(requestTimeoutMs) ||
    requestTimeoutMs < 1 ||
    requestTimeoutMs > 2_147_483_647
  )
    throw new GitHubApiError("invalid_configuration", "Invalid GitHub request bounds");
  const credentialRemaining = Math.ceil(options.deadline - now());
  if (credentialRemaining < 1)
    throw new GitHubApiError("deadline_exceeded", "GitHub credential deadline exhausted");
  const credentialTimeout = AbortSignal.timeout(Math.min(2_147_483_647, credentialRemaining));
  const credentialSignal = AbortSignal.any([
    ...(options.signal ? [options.signal] : []),
    credentialTimeout,
  ]);
  let token: string | undefined;
  try {
    credentialSignal.throwIfAborted();
    if (options.credential.kind === "explicit") token = options.credential.token;
    else if (options.credential.kind === "local") {
      const resolve = options.credential.resolve;
      token = await new Promise<string>((accept, reject) => {
        const abort = () => reject(credentialSignal.reason);
        credentialSignal.addEventListener("abort", abort, { once: true });
        Promise.resolve()
          .then(() => resolve(credentialSignal))
          .then(accept, reject)
          .finally(() => credentialSignal.removeEventListener("abort", abort))
          .catch(() => {});
      });
    }
    credentialSignal.throwIfAborted();
  } catch {
    throw new GitHubApiError(
      credentialSignal.aborted
        ? credentialTimeout.aborted && credentialSignal.reason === credentialTimeout.reason
          ? "deadline_exceeded"
          : "cancelled"
        : now() >= options.deadline
          ? "deadline_exceeded"
          : "credential_unavailable",
      "GitHub credential resolution did not complete",
    );
  }
  if (options.credential.kind !== "anonymous" && (!token || /[\r\n]/u.test(token)))
    throw new GitHubApiError("credential_unavailable", "Required GitHub credential is unavailable");
  const base = new URL(options.baseUrl ?? "https://api.github.com");
  if (base.username || base.password || base.protocol !== "https:")
    throw new GitHubApiError("invalid_configuration", "Invalid GitHub API origin");
  const remaining = Math.ceil(options.deadline - now());
  if (remaining < 1)
    throw new GitHubApiError("deadline_exceeded", "GitHub operation deadline exhausted");
  const sleep =
    options.sleep ??
    ((milliseconds, abort) =>
      new Promise<void>((resolve, reject) => {
        const stop = () => {
          clearTimeout(timer);
          reject(abort.reason);
        };
        const timer = setTimeout(() => {
          abort.removeEventListener("abort", stop);
          resolve();
        }, milliseconds);
        abort.addEventListener("abort", stop, { once: true });
        if (abort.aborted) stop();
      }));
  const client = new Octokit({
    ...(token ? { auth: token } : {}),
    baseUrl: base.href.replace(/\/$/u, ""),
    userAgent: "Portcove/repository",
    log: { debug() {}, info() {}, warn() {}, error() {} },
  });
  if (options.headers) {
    client.request = client.request.defaults({ headers: { ...options.headers } });
    client.graphql = client.graphql.defaults({ headers: { ...options.headers } });
  }
  client.hook.wrap("request", async (request, parameters) => {
    let requestTimedOut = () => false;
    let deadline = options.deadline;
    try {
      const rawPolicy: unknown = parameters.request?.portcove;
      const policy =
        isRecord(rawPolicy) &&
        ["safe-read", "pure-query", "once"].includes(String(rawPolicy.replay)) &&
        Number.isSafeInteger(rawPolicy.attempts) &&
        Number(rawPolicy.attempts) >= 0
          ? (rawPolicy as unknown as GitHubRequestPolicy)
          : { replay: "once" as const, attempts: 0 };
      policy.deadline = Math.min(
        policy.deadline ?? Infinity,
        options.deadline,
        now() + requestTimeoutMs,
      );
      deadline = Math.min(options.deadline, policy.deadline);
      if (deadline <= now())
        throw new GitHubApiError("deadline_exceeded", "GitHub logical request deadline exhausted");
      const requestSignal: unknown = parameters.request?.signal;
      const timeout = AbortSignal.timeout(Math.min(2_147_483_647, Math.ceil(deadline - now())));
      const signal = AbortSignal.any([
        ...(options.signal ? [options.signal] : []),
        timeout,
        ...(requestSignal instanceof AbortSignal ? [requestSignal] : []),
      ]);
      requestTimedOut = () => timeout.aborted && signal.reason === timeout.reason;
      const path = new URL(parameters.url, base).pathname;
      const resource =
        path === "/graphql" ? "graphql" : path.startsWith("/search/") ? "search" : "core";
      const waitUntil = async (
        until: number,
        details: ConstructorParameters<typeof GitHubApiError>[2] = {},
      ) => {
        const delay = Math.max(0, until - wallNow());
        if (now() + delay >= deadline)
          throw new GitHubApiError(
            "rate_limited",
            "GitHub quota deferral exceeds the original deadline",
            {
              ...details,
              retryAfter: String(Math.ceil(delay / 1000)),
            },
          );
        if (delay) await sleep(delay, signal);
      };
      const replayable =
        (policy.replay === "pure-query" &&
          parameters.method === "POST" &&
          new URL(parameters.url, base).pathname === "/graphql") ||
        (policy.replay === "safe-read" && ["GET", "HEAD"].includes(parameters.method));
      const maximum = replayable ? 3 : 1;
      while (policy.attempts < maximum) {
        signal.throwIfAborted();
        if (now() >= deadline)
          throw new GitHubApiError("deadline_exceeded", "GitHub operation deadline exhausted");
        await waitUntil(Math.max(deferral.secondary, deferral.primary.get(resource) ?? 0));
        policy.attempts++;
        const started = now();
        let localFailure: unknown;
        let transportFailure: unknown;
        let requestFailed = false;
        let retryAt = 0;
        let retryDetails: ConstructorParameters<typeof GitHubApiError>[2] = {};
        const observation: GitHubAttemptObservation = {
          attempt: policy.attempts,
          dispatched: false,
          bytes: 0,
          elapsedMs: 0,
          status: null,
          headers: {},
          logicalRequest: policy,
        };
        let reservation: GitHubReservation | undefined;
        const settleAttempt = () => {
          try {
            try {
              reservation?.settle(observation);
            } catch (error) {
              if (!requestFailed || !signal.aborted) throw error;
              const safe = sanitizeOperationError(error, { secrets: token ? [token] : [] });
              policy.admissionSettled = Promise.reject(new GitHubApiError(safe.code, safe.message));
              void policy.admissionSettled.catch(() => {});
            }
          } finally {
            options.observe?.(observation);
          }
        };
        const boundedFetch: typeof globalThis.fetch = async (input, init) => {
          try {
            const url = new URL(
              input instanceof Request ? input.url : input instanceof URL ? input.href : input,
            );
            if (
              url.origin !== base.origin ||
              url.username ||
              url.password ||
              options.allowRequest?.(parameters.method, url) === false
            )
              throw new GitHubApiError(
                "request_refused",
                "GitHub request is outside the admitted scope",
              );
            signal.throwIfAborted();
            if (!token && new Headers(init?.headers).has("authorization"))
              throw new GitHubApiError(
                "request_refused",
                "Anonymous GitHub request contains credentials",
              );
            observation.dispatched = true;
            let response: Response;
            try {
              response = await (options.fetch ?? globalThis.fetch)(input, {
                ...init,
                redirect: "manual",
                signal,
              });
            } catch (error) {
              transportFailure = error;
              throw error;
            }
            observation.status = response.status;
            observation.headers = Object.fromEntries(response.headers);
            if (response.status >= 300 && response.status < 400 && response.status !== 304) {
              await response.body?.cancel();
              throw new GitHubApiError("redirect_refused", "GitHub API redirect was refused");
            }
            const chunks: Uint8Array[] = [];
            const reader = response.body?.getReader();
            const cancel = () => {
              void reader?.cancel(signal.reason).catch(() => {});
            };
            signal.addEventListener("abort", cancel, { once: true });
            try {
              while (reader) {
                signal.throwIfAborted();
                const chunk = await reader.read();
                if (chunk.done) break;
                const bytes: unknown = chunk.value;
                if (!(bytes instanceof Uint8Array))
                  throw new GitHubApiError(
                    "invalid_response",
                    "GitHub body contains invalid bytes",
                  );
                observation.bytes += bytes.byteLength;
                reservation?.consumeBytes(bytes.byteLength);
                if (observation.bytes > maxBytes)
                  throw new GitHubApiError(
                    "response_limit",
                    "GitHub metadata exceeds its byte limit",
                  );
                chunks.push(bytes);
              }
            } finally {
              signal.removeEventListener("abort", cancel);
              await reader?.cancel().catch(() => {});
            }
            signal.throwIfAborted();
            const collected = new Response(
              [204, 205, 304].includes(response.status) ? null : Buffer.concat(chunks),
              {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
              },
            );
            Object.defineProperty(collected, "url", { value: response.url || url.href });
            return collected;
          } catch (error) {
            if (error !== transportFailure) localFailure = error;
            throw error;
          }
        };
        try {
          const reserve = policy.reserve ?? options.reserve;
          if (reserve) {
            const pending = Promise.resolve().then(() =>
              reserve({
                method: parameters.method,
                url: new URL(parameters.url, base),
                replay: policy.replay,
                signal,
              }),
            );
            reservation = await new Promise<GitHubReservation>((resolve, reject) => {
              let abandoned = false;
              const abort = () => {
                abandoned = true;
                policy.admissionSettled = pending
                  .then((unused) => {
                    unused.settle({ ...observation, elapsedMs: now() - started });
                  })
                  .catch((error) => {
                    const safe = sanitizeOperationError(error, { secrets: token ? [token] : [] });
                    throw new GitHubApiError(safe.code, safe.message);
                  });
                // Keep the rejection available to the owning operation's join,
                // including when it has not observed this attempt yet.
                void policy.admissionSettled.catch(() => {});
                reject(signal.reason);
              };
              if (signal.aborted) {
                abort();
                return;
              }
              signal.addEventListener("abort", abort, { once: true });
              void pending.then(
                (value) => {
                  if (abandoned) return;
                  signal.removeEventListener("abort", abort);
                  resolve(value);
                },
                (error) => {
                  if (abandoned) return;
                  signal.removeEventListener("abort", abort);
                  reject(error);
                },
              );
            });
          }
          signal.throwIfAborted();
          // Earlier hooks (notably token auth) bind this original options object.
          // Replacing it here would let that hook discard the bounded fetch.
          parameters.request = { ...parameters.request, fetch: boundedFetch, signal };
          const result = await request(parameters);
          requireJsonValues(result.data as unknown);
          const body: unknown = result.data;
          observation.rate = rateLimitFromResponse({
            headers: new Map(Object.entries(observation.headers)),
            body,
          });
          if (
            path === "/graphql" &&
            isRecord(body) &&
            Array.isArray(body.errors) &&
            body.errors.length
          )
            throw Object.assign(
              new Error(
                body.errors
                  .map((entry: unknown) =>
                    isRecord(entry) && typeof entry.message === "string"
                      ? entry.message
                      : "GitHub GraphQL error",
                  )
                  .join("; "),
              ),
              {
                response: result,
              },
            );
          if (now() >= deadline)
            throw new GitHubApiError(
              "deadline_exceeded",
              "GitHub response processing exceeded the original deadline",
            );
          signal.throwIfAborted();
          return result;
        } catch (error) {
          requestFailed = true;
          if (localFailure || signal.aborted) {
            const safe = sanitizeOperationError(localFailure ?? signal.reason, {
              secrets: token ? [token] : [],
            });
            throw new GitHubApiError(
              signal.aborted ? (requestTimedOut() ? "deadline_exceeded" : "cancelled") : safe.code,
              safe.message,
            );
          }
          const response: unknown = isRecord(error) ? error.response : undefined;
          const body: unknown = isRecord(response) ? response.data : undefined;
          const rate = rateLimitFromResponse({
            headers: new Map(Object.entries(observation.headers)),
            body,
          });
          observation.rate = rate;
          const errors: unknown[] =
            path === "/graphql" && isRecord(body) && Array.isArray(body.errors) ? body.errors : [];
          const rateErrors = errors.some(
            (entry) =>
              isRecord(entry) &&
              (entry.type === "RATE_LIMITED" ||
                (isRecord(entry.extensions) && entry.extensions.code === "RATE_LIMITED")),
          );
          const message =
            isRecord(body) && typeof body.message === "string"
              ? body.message
              : errors
                  .map((entry) =>
                    isRecord(entry) && typeof entry.message === "string" ? entry.message : "",
                  )
                  .join("; ");
          const secondary = /secondary rate limit|abuse detection/iu.test(message);
          const limited =
            observation.status === 429 ||
            rateErrors ||
            ((observation.status === 403 || errors.length > 0) &&
              (rate.remaining === 0 ||
                secondary ||
                observation.headers["retry-after"] !== undefined));
          if (limited) {
            retryDetails = {
              status: observation.status,
              rateLimit: rate,
              requestId: observation.headers["x-github-request-id"] ?? null,
              responseDate: observation.headers.date ?? null,
              responseBytes: observation.bytes,
            };
            const primary =
              rate.remaining === 0 && rate.resetAt !== null && Date.parse(rate.resetAt) > wallNow();
            const retryAfter = observation.headers["retry-after"];
            const required =
              retryAfter === undefined
                ? NaN
                : /^\d+$/u.test(retryAfter)
                  ? wallNow() + Number(retryAfter) * 1000
                  : Date.parse(retryAfter);
            let until = Math.max(
              primary ? Date.parse(rate.resetAt!) : 0,
              Number.isFinite(required) ? required : 0,
            );
            if (until <= wallNow()) {
              policy.secondaryFailures = (policy.secondaryFailures ?? 0) + 1;
              until = wallNow() + 60_000 * 2 ** (policy.secondaryFailures - 1);
            }
            if (primary && !secondary) deferral.primary.set(rate.resource ?? resource, until);
            else deferral.secondary = Math.max(deferral.secondary, until);
            if (replayable && !errors.length && policy.attempts < maximum) {
              retryAt = until;
            }
          }
          if (
            observation.status === 304 &&
            parameters.method === "GET" &&
            Object.keys(parameters.headers).some((key) => key.toLowerCase() === "if-none-match") &&
            isRecord(response)
          )
            return {
              status: 304,
              url: new URL(parameters.url, base).href,
              headers: { ...observation.headers },
              data: null,
            };
          const cause = isRecord(transportFailure) ? transportFailure.cause : undefined;
          const transient =
            observation.status !== null
              ? transientStatuses.has(observation.status)
              : isRecord(cause) && transientCauses.has(String(cause.code));
          if (!retryAt && (!replayable || !transient || policy.attempts >= maximum)) {
            const safe = sanitizeOperationError(error, { secrets: token ? [token] : [] });
            throw new GitHubApiError(
              limited ? "rate_limited" : errors.length ? "graphql_error" : safe.code,
              safe.message,
              {
                status: observation.status,
                rateLimit: rate,
                retryAfter: observation.headers["retry-after"] ?? null,
                responseDate: observation.headers.date ?? null,
                responseBytes: observation.bytes,
                requestId: observation.headers["x-github-request-id"] ?? null,
              },
            );
          }
        } finally {
          observation.elapsedMs = now() - started;
          observation.rate ??= rateLimitFromResponse({
            headers: new Map(Object.entries(observation.headers)),
            body: null,
          });
          settleAttempt();
        }
        if (retryAt) {
          await waitUntil(retryAt, retryDetails);
          continue;
        }
        const delay =
          Math.max(0, Math.min(1, (options.random ?? Math.random)())) * 500 * policy.attempts;
        if (now() + delay >= deadline)
          throw new GitHubApiError(
            "deadline_exceeded",
            "GitHub retry cannot fit the original deadline",
          );
        await sleep(delay, signal);
      }
      throw new GitHubApiError(
        "retry_exhausted",
        "GitHub logical request attempt allowance is exhausted",
      );
    } catch (error) {
      const safe = sanitizeOperationError(error, { secrets: token ? [token] : [] });
      const requestSignal: unknown = parameters.request?.signal;
      const aborted =
        options.signal?.aborted || (requestSignal instanceof AbortSignal && requestSignal.aborted);
      const details =
        error instanceof GitHubApiError
          ? {
              status: error.status,
              rateLimit: error.rateLimit,
              retryAfter: error.retryAfter,
              requestId: error.requestId,
              responseDate: error.responseDate,
              responseBytes: error.responseBytes,
            }
          : {};
      throw new GitHubApiError(
        error instanceof GitHubApiError
          ? safe.code
          : requestTimedOut()
            ? "deadline_exceeded"
            : aborted
              ? "cancelled"
              : now() >= deadline
                ? "deadline_exceeded"
                : "invalid_response",
        safe.message,
        details,
      );
    }
  });
  return client;
}

/** SDK-owned ordinary pagination with original response envelopes. Inventory
 * eligibility, stability and completeness remain with each domain owner. */
export async function* iterateGitHubPages(
  client: Octokit,
  options: {
    url: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
    deadline?: number;
    reserve?: GitHubClientOptions["reserve"];
  },
) {
  type Response = Awaited<ReturnType<Octokit["request"]>>;
  const originals = new WeakMap<object, Response>();
  const seen = new Set<string>();
  let failure: Error | undefined;
  const request = Object.assign(
    async (parameters: { method: "GET"; url: string; headers: Record<string, string> }) => {
      try {
        if (seen.has(parameters.url))
          throw new GitHubApiError("invalid_response", "GitHub pagination did not advance");
        seen.add(parameters.url);
        const response = await client.request({
          ...parameters,
          request: {
            ...(options.signal ? { signal: options.signal } : {}),
            portcove: {
              replay: "safe-read",
              attempts: 0,
              ...(options.deadline === undefined ? {} : { deadline: options.deadline }),
              ...(options.reserve ? { reserve: options.reserve } : {}),
            },
          },
        });
        // The SDK mutates list envelopes during normalization. Retain the
        // original bounded JSON representation for consumed count/shape checks.
        originals.set(response, { ...response, data: structuredClone(response.data as unknown) });
        return response;
      } catch (error) {
        failure =
          error instanceof Error
            ? error
            : new GitHubApiError("request_failed", "GitHub pagination request failed");
        throw failure;
      }
    },
    { endpoint: client.request.endpoint, defaults: client.request.defaults },
  ) as Octokit["request"] &
    ((parameters: {
      method: "GET";
      url: string;
      headers?: Record<string, string>;
    }) => Promise<Response>);
  const pages: AsyncIterable<unknown> = composePaginateRest.iterator(client, request, {
    method: "GET",
    url: options.url,
    ...(options.headers ? { headers: options.headers } : {}),
  });
  try {
    for await (const page of pages) {
      // paginate-rest synthesizes an empty 200 for409. No provider failure may
      // become a successful empty collection at Portcove's boundary.
      if (failure !== undefined) throw failure;
      const original = isRecord(page) ? originals.get(page) : undefined;
      if (!original)
        throw new GitHubApiError(
          "invalid_response",
          "GitHub pagination lost its response evidence",
        );
      yield original;
    }
  } catch (error) {
    if (failure !== undefined) throw failure;
    if (error instanceof GitHubApiError) throw error;
    throw new GitHubApiError(
      "invalid_response",
      "GitHub pagination could not normalize its response",
    );
  }
}
