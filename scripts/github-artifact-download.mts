import { createGitHubClient } from "./github-client.mts";
import type { GitHubCredential } from "./github-client.mts";
import { GitHubApiError } from "./github-operation.mts";

/** GitHub Actions redirects the authenticated API lookup to a short-lived
 * blob URL. Keep that URL out of observations, diagnostics and persistence. */
export async function downloadGitHubArtifactArchive(
  endpoint: string,
  options: {
    credential: GitHubCredential;
    deadline: number;
    maxBytes: number;
    fetch?: typeof globalThis.fetch;
  },
): Promise<Buffer> {
  const { credential, deadline, maxBytes, fetch: fetcher = globalThis.fetch } = options;
  if (
    !/^repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/artifacts\/[1-9][0-9]{0,15}\/zip$/u.test(
      endpoint,
    ) ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 22 ||
    maxBytes > 8 * 1024 * 1024 ||
    !Number.isFinite(deadline) ||
    deadline - performance.now() > 120000
  )
    throw new GitHubApiError("invalid_configuration", "Bounded GitHub artifact lookup required");
  const api = await createGitHubClient({
    credential,
    deadline,
    maxBytes: 128 * 1024,
    fetch: fetcher,
    observeRedirects: true,
    allowRequest: (method, url) =>
      method === "GET" && url.pathname === `/${endpoint}` && !url.search,
  });
  const lookup = await api.request(`GET /${endpoint}`, {
    request: { portcove: { replay: "once", attempts: 0, readRedirectBodyFor: [] } },
  });
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
  const signal = AbortSignal.timeout(remaining);
  const chunks: Uint8Array[] = [];
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
        chunks.push(payload);
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
    if (signal.aborted)
      throw new GitHubApiError("deadline_exceeded", "GitHub artifact deadline exhausted");
    throw new GitHubApiError("request_failed", "GitHub artifact delivery failed");
  }
  return Buffer.concat(chunks, bytes);
}
