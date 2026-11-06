import { createHash } from "node:crypto";
import { open, unlink, type FileHandle } from "node:fs/promises";
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
  /** Bounds and accounting for the authenticated lookup only. The signed transfer uses
   * the original delivery deadline and never enters the GitHub API budget. */
  lookup?: Pick<GitHubRequestPolicy, "deadline"> &
    Pick<GitHubClientOptions, "reserve"> & {
      elapsed?: (milliseconds: number) => void;
      requestTimeoutMs?: number;
    };
};

async function transferGitHubArtifactArchive(
  endpoint: string,
  options: ArtifactDownloadOptions,
  maximum: number,
  receive: (chunk: Uint8Array) => void | Promise<void>,
  maximumDuration = 120000,
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
    deadline - performance.now() > maximumDuration
  )
    throw new GitHubApiError("invalid_configuration", "Bounded GitHub artifact lookup required");
  const api = await createGitHubClient({
    credential,
    deadline,
    maxBytes: 128 * 1024,
    requestTimeoutMs:
      options.lookup?.requestTimeoutMs ?? (maximumDuration > 120000 ? maximumDuration : 15000),
    fetch: fetcher,
    ...(options.signal ? { signal: options.signal } : {}),
    observeRedirects: true,
    allowRequest: (method, url) =>
      method === "GET" && url.pathname === `/${endpoint}` && !url.search,
  });
  const policy = downloadRequestPolicy(options);
  let lookup;
  try {
    lookup = await api.request(`GET /${endpoint}`, { request: { portcove: policy } });
  } finally {
    await policy.admissionSettled;
  }
  const delivery = signedDelivery(lookup.status, lookup.headers.location);
  if (
    !delivery ||
    !/^productionresultssa[0-9]+\.blob\.core\.windows\.net$/u.test(delivery.hostname) ||
    !delivery.pathname.startsWith("/actions-results/")
  )
    throw new GitHubApiError("redirect_refused", "GitHub artifact delivery address refused");
  return transferSignedDelivery(delivery, { ...options, fetch: fetcher }, receive);
}

function downloadRequestPolicy(options: ArtifactDownloadOptions): GitHubRequestPolicy {
  const { deadline: lookupDeadline, reserve, elapsed } = options.lookup ?? {};
  return {
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
}

function signedDelivery(status: number, location: unknown) {
  let url: URL | undefined;
  if (status === 302 && typeof location === "string" && location.length <= 8192) {
    try {
      url = new URL(location);
    } catch {
      // The URL may contain a signed credential.
    }
  }
  return url &&
    url.protocol === "https:" &&
    !url.port &&
    !url.username &&
    !url.password &&
    !url.hash &&
    url.search
    ? url
    : undefined;
}

async function transferSignedDelivery(
  delivery: URL,
  options: ArtifactDownloadOptions,
  receive: (chunk: Uint8Array) => void | Promise<void>,
) {
  const { deadline, maxBytes, fetch: fetcher = globalThis.fetch } = options;
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
  options: ArtifactDownloadOptions & { bufferAllowance?: "ci-provenance" },
): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  const maximum = (options.bufferAllowance === "ci-provenance" ? 20 : 8) * 1024 * 1024;
  const bytes = await transferGitHubArtifactArchive(endpoint, options, maximum, (chunk) => {
    chunks.push(chunk);
  });
  return Buffer.concat(chunks, bytes);
}

async function transferGitHubReleaseAsset(
  id: number,
  options: ArtifactDownloadOptions,
  maximum: number,
  receive: (chunk: Uint8Array) => void | Promise<void>,
) {
  const { credential, deadline, maxBytes, fetch, signal } = options;
  if (
    !Number.isSafeInteger(id) ||
    id < 1 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > maximum ||
    !Number.isFinite(deadline) ||
    deadline - performance.now() > 120000
  )
    throw new GitHubApiError(
      "invalid_configuration",
      "Bounded exact GitHub release asset required",
    );
  const pathname = `/repos/boburning/portcove/releases/assets/${id}`;
  const api = await createGitHubClient({
    credential,
    deadline,
    requestTimeoutMs: 120000,
    maxBytes: 128 * 1024,
    observeRedirects: true,
    headers: { accept: "application/octet-stream" },
    allowRequest: (method, url) => method === "GET" && url.pathname === pathname && !url.search,
    ...(fetch ? { fetch } : {}),
    ...(signal ? { signal } : {}),
  });
  let bytes = 0;
  const accept = async (chunk: Uint8Array) => {
    await receive(chunk);
    bytes += chunk.byteLength;
  };
  const policy = downloadRequestPolicy(options);
  policy.binaryResponse = { maxBytes, receive: accept };
  let lookup;
  try {
    lookup = await api.request(`GET ${pathname}`, { request: { portcove: policy } });
  } finally {
    await policy.admissionSettled;
  }
  if (lookup.status !== 200) {
    const delivery = signedDelivery(lookup.status, lookup.headers.location);
    if (
      !delivery ||
      !["release-assets.githubusercontent.com", "objects.githubusercontent.com"].includes(
        delivery.hostname,
      )
    )
      throw new GitHubApiError("redirect_refused", "GitHub release asset delivery address refused");
    await transferSignedDelivery(delivery, options, accept);
  }
  if (bytes !== maxBytes)
    throw new GitHubApiError("invalid_response", "GitHub release asset byte count differs");
  if (signal?.aborted) throw new GitHubApiError("cancelled", "GitHub release asset cancelled");
  if (performance.now() >= deadline)
    throw new GitHubApiError("deadline_exceeded", "GitHub release asset deadline exhausted");
  return bytes;
}

/** Exact numeric Release asset lookup for bounded documents such as the SBOM. */
export async function downloadGitHubReleaseAsset(id: number, options: ArtifactDownloadOptions) {
  const chunks: Uint8Array[] = [];
  const bytes = await transferGitHubReleaseAsset(id, options, 16 * 1024 * 1024, (chunk) => {
    chunks.push(chunk);
  });
  return Buffer.concat(chunks, bytes);
}

/** Large immutable Release assets remain file-backed. */
export async function downloadGitHubReleaseAssetFile(
  id: number,
  filename: string,
  options: ArtifactDownloadOptions,
) {
  return writeExclusiveDownload(filename, async (file) => {
    const digest = createHash("sha256");
    const bytes = await transferGitHubReleaseAsset(
      id,
      options,
      512 * 1024 * 1024,
      async (chunk) => {
        await file.writeFile(chunk);
        digest.update(chunk);
      },
    );
    return { bytes, sha256: digest.digest("hex"), identity: await file.stat({ bigint: true }) };
  });
}

/** Stream an exact admitted archive into an exclusively owned scratch file.
 * The caller must still verify its digest and archive structure. */
export async function downloadGitHubArtifactArchiveFile(
  endpoint: string,
  filename: string,
  options: ArtifactDownloadOptions,
) {
  return writeExclusiveDownload(filename, async (file) => {
    const bytes = await transferGitHubArtifactArchive(
      endpoint,
      options,
      512 * 1024 * 1024,
      (chunk) => file.writeFile(chunk),
    );
    if (bytes !== options.maxBytes)
      throw new GitHubApiError("invalid_response", "GitHub artifact byte count differs");
  });
}

/** The frozen Linux reboot cohort needs a larger file-backed transfer. Keep its
 * original ten-minute deadline and retain failed bytes for private diagnosis. */
export async function downloadRetainedRebootArtifactFile(
  endpoint: string,
  filename: string,
  options: ArtifactDownloadOptions,
) {
  return writeExclusiveDownload(
    filename,
    async (file) => {
      const digest = createHash("sha256");
      const bytes = await transferGitHubArtifactArchive(
        endpoint,
        options,
        640 * 1024 * 1024,
        async (chunk) => {
          await file.writeFile(chunk);
          digest.update(chunk);
        },
        600000,
      );
      if (bytes !== options.maxBytes)
        throw new GitHubApiError("invalid_response", "GitHub artifact byte count differs");
      await file.sync();
      return { bytes, sha256: digest.digest("hex") };
    },
    true,
  );
}

async function writeExclusiveDownload<T>(
  filename: string,
  transfer: (file: FileHandle) => Promise<T>,
  retainPartial = false,
) {
  const file = await open(filename, "wx", 0o600);
  let complete = false;
  try {
    let result: T;
    try {
      result = await transfer(file);
    } finally {
      await file.close();
    }
    complete = true;
    return result;
  } finally {
    if (!complete && !retainPartial) await unlink(filename);
  }
}
