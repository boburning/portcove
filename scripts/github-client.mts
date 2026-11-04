import { Octokit } from "@octokit/core";
import { GitHubApiError, sanitizeOperationError } from "./github-operation.mts";
import { isRecord } from "./runtime-values.mts";

export type GitHubCredential =
  | { kind: "anonymous" }
  | { kind: "explicit"; token: string }
  | { kind: "local"; token: Promise<string> };

/** Reuse this object when recovering the same logical read; stability reads
 * receive a new object. No URL-keyed or process-global retry ledger exists. */
export interface GitHubRequestPolicy {
  replay: "safe-read" | "pure-query" | "once";
  attempts: number;
}
export interface GitHubAttemptObservation {
  attempt: number;
  dispatched: boolean;
  bytes: number;
  elapsedMs: number;
  status: number | null;
  headers: Readonly<Record<string, string>>;
}
export interface GitHubClientOptions {
  credential: GitHubCredential;
  /** Monotonic, operation-wide deadline, never renewed by retries. */
  deadline: number;
  signal?: AbortSignal;
  maxBytes?: number;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  random?: () => number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  allowRequest?: (method: string, url: URL) => boolean;
  /** Existing domain accounting reserves before dispatch and settles every
   * outcome, including local refusal and cancellation after send. */
  reserve?: () => {
    consumeBytes: (bytes: number) => void;
    settle: (observation: GitHubAttemptObservation) => void;
  };
  observe?: (observation: GitHubAttemptObservation) => void;
}

const transientStatuses = new Set([408, 500, 502, 503, 504]);
const transientCauses = new Set(["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ECONNREFUSED"]);

/** One neutral factory. No ambient credentials, domain imports, cache, inventory
 * interpretation or SDK retry/throttling plugin is installed here. */
export async function createGitHubClient(options: GitHubClientOptions) {
  const now = options.now ?? (() => performance.now());
  const maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isFinite(options.deadline))
    throw new GitHubApiError("invalid_configuration", "Invalid GitHub request bounds");
  const token =
    options.credential.kind === "anonymous" ? undefined : await options.credential.token;
  if (options.credential.kind !== "anonymous" && (!token || /[\r\n]/u.test(token)))
    throw new GitHubApiError("credential_unavailable", "Required GitHub credential is unavailable");
  const base = new URL(options.baseUrl ?? "https://api.github.com");
  if (base.username || base.password || base.protocol !== "https:")
    throw new GitHubApiError("invalid_configuration", "Invalid GitHub API origin");
  const remaining = Math.ceil(options.deadline - now());
  if (remaining < 1)
    throw new GitHubApiError("deadline_exceeded", "GitHub operation deadline exhausted");
  const operationSignal = AbortSignal.any([
    ...(options.signal ? [options.signal] : []),
    AbortSignal.timeout(remaining),
  ]);
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
  client.hook.wrap("request", async (request, parameters) => {
    const requestSignal: unknown = parameters.request?.signal;
    const signal = AbortSignal.any([
      operationSignal,
      ...(requestSignal instanceof AbortSignal ? [requestSignal] : []),
    ]);
    const rawPolicy: unknown = parameters.request?.portcove;
    const policy =
      isRecord(rawPolicy) &&
      ["safe-read", "pure-query", "once"].includes(String(rawPolicy.replay)) &&
      Number.isSafeInteger(rawPolicy.attempts) &&
      Number(rawPolicy.attempts) >= 0
        ? (rawPolicy as unknown as GitHubRequestPolicy)
        : { replay: "once" as const, attempts: 0 };
    const replayable =
      (policy.replay === "pure-query" &&
        parameters.method === "POST" &&
        new URL(parameters.url, base).pathname === "/graphql") ||
      (policy.replay === "safe-read" && ["GET", "HEAD"].includes(parameters.method));
    const maximum = replayable ? 3 : 1;
    while (policy.attempts < maximum) {
      signal.throwIfAborted();
      if (now() >= options.deadline)
        throw new GitHubApiError("deadline_exceeded", "GitHub operation deadline exhausted");
      policy.attempts++;
      const started = now();
      let localFailure: unknown;
      let transportFailure: unknown;
      const observation: GitHubAttemptObservation = {
        attempt: policy.attempts,
        dispatched: false,
        bytes: 0,
        elapsedMs: 0,
        status: null,
        headers: {},
      };
      const reservation = options.reserve?.();
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
                throw new GitHubApiError("invalid_response", "GitHub body contains invalid bytes");
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
          return new Response(
            [204, 205, 304].includes(response.status) ? null : Buffer.concat(chunks),
            {
              status: response.status,
              statusText: response.statusText,
              headers: response.headers,
            },
          );
        } catch (error) {
          if (error !== transportFailure) localFailure = error;
          throw error;
        }
      };
      try {
        // Earlier hooks (notably token auth) bind this original options object.
        // Replacing it here would let that hook discard the bounded fetch.
        parameters.request = { ...parameters.request, fetch: boundedFetch, signal };
        return await request(parameters);
      } catch (error) {
        if (localFailure || signal.aborted) throw localFailure ?? signal.reason;
        const cause = isRecord(transportFailure) ? transportFailure.cause : undefined;
        const transient =
          observation.status !== null
            ? transientStatuses.has(observation.status)
            : isRecord(cause) && transientCauses.has(String(cause.code));
        if (!replayable || !transient || policy.attempts >= maximum) {
          const safe = sanitizeOperationError(error, { secrets: token ? [token] : [] });
          throw new GitHubApiError(safe.code, safe.message, {
            status: observation.status,
            responseBytes: observation.bytes,
            requestId: observation.headers["x-github-request-id"] ?? null,
          });
        }
      } finally {
        observation.elapsedMs = now() - started;
        reservation?.settle(observation);
        options.observe?.(observation);
      }
      const delay =
        Math.max(0, Math.min(1, (options.random ?? Math.random)())) * 500 * policy.attempts;
      if (now() + delay >= options.deadline)
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
  });
  return client;
}
