import { open, unlink } from "node:fs/promises";
import { createGitHubClient, retainedGitHubHeaders } from "./github-client.mts";
import type {
  GitHubClientOptions,
  GitHubCredential,
  GitHubRequestPolicy,
} from "./github-client.mts";
import { GitHubApiError } from "./github-operation.mts";

/** GitHub Actions redirects the authenticated API lookup to a short-lived
 * blob URL. Keep that URL out of observations, diagnostics and persistence. */
type ArtifactDownloadOptions = {
  credential: GitHubCredential;
  deadline: number;
  maxBytes: number;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  /** Accounting for the authenticated lookup only. The signed transfer uses
   * the original delivery deadline and never enters the GitHub API budget. */
  lookup?: Pick<GitHubRequestPolicy, "deadline"> &
    Pick<GitHubClientOptions, "reserve"> & {
      elapsed?: (milliseconds: number) => void;
    };
};

async function transferGitHubArtifactArchive(
  endpoint: string,
  options: ArtifactDownloadOptions,
  maximum: number,
  receive: (chunk: Uint8Array) => void | Promise<void>,
) {
  const { credential, deadline, maxBytes, fetch: fetcher = globalThis.fetch } = options;
  if (
    !/^repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/artifacts\/[1-9][0-9]{0,15}\/zip$/u.test(
      endpoint,
    ) ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 22 ||
    maxBytes > maximum ||
    !Number.isFinite(deadline) ||
    deadline - performance.now() > 120000
  )
    throw new GitHubApiError("invalid_configuration", "Bounded GitHub artifact lookup required");
  const api = await createGitHubClient({
    credential,
    deadline,
    maxBytes: 128 * 1024,
    fetch: fetcher,
    ...(options.signal ? { signal: options.signal } : {}),
    observeRedirects: true,
    allowRequest: (method, url) =>
      method === "GET" && url.pathname === `/${endpoint}` && !url.search,
  });
  const { deadline: lookupDeadline, reserve, elapsed } = options.lookup ?? {};
  const policy: GitHubRequestPolicy = {
    ...(lookupDeadline === undefined ? {} : { deadline: lookupDeadline }),
    ...(reserve
      ? {
          async reserve(request) {
            const reservation = await reserve(request);
            return {
              consumeBytes: (bytes) => reservation.consumeBytes(bytes),
              settle(observation) {
                const headers = retainedGitHubHeaders(observation.headers);
                // Artifact lookups have no pagination evidence.
                delete headers.link;
                reservation.settle({ ...observation, headers });
              },
            };
          },
        }
      : {}),
    ...(elapsed ? { observe: (observation) => elapsed(observation.elapsedMs) } : {}),
    replay: "once",
    attempts: 0,
    readRedirectBodyFor: [],
  };
  let lookup;
  try {
    lookup = await api.request(`GET /${endpoint}`, { request: { portcove: policy } });
  } finally {
    await policy.admissionSettled;
  }
  const location = lookup.headers.location;
  let delivery: URL | undefined;
  if (lookup.status === 302 && typeof location === "string" && location.length <= 8192) {
    try {
      delivery = new URL(location);
    } catch {
      // The URL may contain a signed credential.
    }
  }
  if (
    !delivery ||
    delivery.protocol !== "https:" ||
    delivery.port ||
    delivery.username ||
    delivery.password ||
    delivery.hash ||
    !/^productionresultssa[0-9]+\.blob\.core\.windows\.net$/u.test(delivery.hostname) ||
    !delivery.pathname.startsWith("/actions-results/") ||
    !delivery.search
  )
    throw new GitHubApiError("redirect_refused", "GitHub artifact delivery address refused");

  const remaining = Math.ceil(deadline - performance.now());
  if (remaining < 1)
    throw new GitHubApiError("deadline_exceeded", "GitHub artifact deadline exhausted");
  const timeout = AbortSignal.timeout(remaining);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  let bytes = 0;
  try {
    const response = await fetcher(delivery, {
      method: "GET",
      credentials: "omit",
      redirect: "manual",
      signal,
    });
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel();
      throw new GitHubApiError("request_failed", "GitHub artifact delivery unavailable");
    }
    const reader = response.body.getReader();
    const cancel = () => {
      void reader.cancel(signal.reason).catch(() => {});
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      for (;;) {
        signal.throwIfAborted();
        const chunk = await reader.read();
        if (chunk.done) break;
        const payload: unknown = chunk.value;
        if (!(payload instanceof Uint8Array))
          throw new GitHubApiError(
            "invalid_response",
            "GitHub artifact body contains invalid bytes",
          );
        bytes += payload.byteLength;
        if (bytes > maxBytes)
          throw new GitHubApiError("response_limit", "GitHub artifact exceeds its byte limit");
        await receive(payload);
      }
    } finally {
      signal.removeEventListener("abort", cancel);
      await reader.cancel().catch(() => {});
    }
    signal.throwIfAborted();
    if (performance.now() >= deadline)
      throw new GitHubApiError("deadline_exceeded", "GitHub artifact deadline exhausted");
  } catch (error) {
    if (error instanceof GitHubApiError) throw error;
    if (timeout.aborted)
      throw new GitHubApiError("deadline_exceeded", "GitHub artifact deadline exhausted");
    if (signal.aborted) throw new GitHubApiError("cancelled", "GitHub artifact delivery cancelled");
    throw new GitHubApiError("request_failed", "GitHub artifact delivery failed");
  }
  return bytes;
}

export async function downloadGitHubArtifactArchive(
  endpoint: string,
  options: ArtifactDownloadOptions,
): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  const bytes = await transferGitHubArtifactArchive(endpoint, options, 8 * 1024 * 1024, (chunk) => {
    chunks.push(chunk);
  });
  return Buffer.concat(chunks, bytes);
}

/** Stream an exact admitted archive into an exclusively owned scratch file.
 * The caller must still verify its digest and archive structure. */
export async function downloadGitHubArtifactArchiveFile(
  endpoint: string,
  filename: string,
  options: ArtifactDownloadOptions,
) {
  const file = await open(filename, "wx", 0o600);
  let complete = false;
  try {
    try {
      const bytes = await transferGitHubArtifactArchive(
        endpoint,
        options,
        512 * 1024 * 1024,
        (chunk) => file.writeFile(chunk),
      );
      if (bytes !== options.maxBytes)
        throw new GitHubApiError("invalid_response", "GitHub artifact byte count differs");
    } finally {
      await file.close();
    }
    complete = true;
  } finally {
    if (!complete) await unlink(filename);
  }
}
