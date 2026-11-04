import { readOnlyReleaseChildEnvironment } from "./release-readonly-child-environment.mts";
import { errorCode, errorMessage, isRecord } from "./runtime-values.mts";
import type { SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  coordinatorCommandTimeout,
  checkCoordinatorDeadline,
} from "./release-coordinator-deadline.mts";

import { GitHubApiError, sanitizeOperationError } from "./github-operation.mts";
import type { IncludedResponse, GitHubRestReader, GitHubRateLimit } from "./github-operation.mts";
export {
  GitHubApiError,
  sanitizeOperationError,
  githubOperationEnvelope,
} from "./github-operation.mts";
export type {
  IncludedResponse,
  GitHubRestReader,
  GitHubRateLimit,
  OperationStatus,
} from "./github-operation.mts";
export type GitHubRunner = (args: readonly string[], input?: string) => string;

export function parseIncludedResponse(output: unknown): IncludedResponse {
  const raw: unknown = output ?? "";
  const text = String(raw);
  if (!text.trim())
    return { headers: new Map<string, string>(), body: null, bodyBytes: Buffer.byteLength(text) };
  if (text.trimStart().startsWith("{") || text.trimStart().startsWith("[")) {
    return {
      headers: new Map<string, string>(),
      body: JSON.parse(text),
      bodyBytes: Buffer.byteLength(text),
    };
  }

  const blocks = [...text.matchAll(/(?:^|\r?\n)(HTTP\/[^\r\n]+\r?\n(?:[^\r\n]*\r?\n)*?)\r?\n/gmu)];
  const block = blocks.at(-1);
  if (!block) throw new Error("GitHub API response did not contain JSON or HTTP headers");
  const lines = (block[1] ?? "").trim().split(/\r?\n/u);
  const status = Number(lines.shift()?.match(/^HTTP\/\S+\s+(\d+)/u)?.[1]);
  if (!Number.isInteger(status)) throw new Error("GitHub API response had an invalid HTTP status");
  const headers = new Map<string, string>();
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator < 1) throw new Error(`GitHub API response had a malformed header: ${line}`);
    headers.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
  }
  const bodyText = text.slice((block.index ?? 0) + block[0].length);
  return {
    status,
    headers,
    body: bodyText.trim() ? JSON.parse(bodyText) : null,
    bodyBytes: Buffer.byteLength(bodyText),
  };
}

export { rateLimitFromResponse } from "./github-operation.mts";
import { rateLimitFromResponse } from "./github-operation.mts";

export { nextLink } from "./github-operation.mts";
import { nextLink } from "./github-operation.mts";

export function githubRateLimitMessage(
  rate: Pick<GitHubRateLimit, "remaining" | "resetAt"> | null | undefined,
  prefix = "GitHub API rate limit",
) {
  const remaining = rate?.remaining ?? "unknown";
  const reset = rate?.resetAt ?? "unknown";
  return `${prefix}: ${remaining} points remain; reset at ${reset}`;
}

function graphqlResponseError(response: IncludedResponse, operation: string) {
  const errors = isRecord(response.body) ? response.body.errors : undefined;
  if (!Array.isArray(errors) || !errors.length) return null;
  const rateLimit = rateLimitFromResponse(response);
  const limited =
    rateLimit.remaining === 0 ||
    response.status === 429 ||
    response.headers.has("retry-after") ||
    errors.some(
      (entry: unknown) =>
        isRecord(entry) &&
        (entry.type === "RATE_LIMITED" ||
          (isRecord(entry.extensions) && entry.extensions.code === "RATE_LIMITED")),
    );
  const message = errors
    .map((error: unknown) =>
      isRecord(error) && typeof error.message === "string" ? error.message : "unknown error",
    )
    .join("; ");
  return new GitHubApiError(
    limited ? "rate_limited" : "graphql_error",
    `${message}${rateLimit.remaining !== null ? ` (${githubRateLimitMessage(rateLimit)})` : ""}`,
    {
      operation,
      status: response.status ?? null,
      rateLimit,
      retryAfter: response.headers.get("retry-after") ?? null,
      requestId: response.headers.get("x-github-request-id") ?? null,
      responseDate: response.headers.get("date") ?? null,
      responseBytes: response.bodyBytes ?? null,
    },
  );
}

export function createGitHubRunner({
  cwd = process.cwd(),
  command = "gh",
  spawn = spawnSync,
  maxBuffer = 16 * 1024 * 1024,
  timeoutMs = 15_000,
}: {
  cwd?: string;
  command?: string;
  spawn?: (
    command: string,
    args: readonly string[],
    options: SpawnSyncOptionsWithStringEncoding,
  ) => { status: number | null; stdout: string; stderr: string; error?: Error | null };
  maxBuffer?: number;
  timeoutMs?: number;
} = {}): GitHubRunner {
  if (!Number.isSafeInteger(maxBuffer) || maxBuffer <= 0)
    throw new RangeError("GitHub API output limit must be a positive safe integer number of bytes");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647)
    throw new RangeError(
      "GitHub API timeout must be a positive integer up to 2147483647 milliseconds",
    );
  return (args, input) => {
    const result = spawn(command, args, {
      cwd,
      ...(readOnlyReleaseChildEnvironment() === undefined
        ? {}
        : { env: readOnlyReleaseChildEnvironment() }),
      encoding: "utf8",
      input,
      maxBuffer,
      timeout: coordinatorCommandTimeout(timeoutMs),
      killSignal: "SIGKILL",
      stdio: input === undefined ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const operation = `gh ${args.slice(0, 3).join(" ")}`;
    if (result.error) {
      if (errorCode(result.error) === "ETIMEDOUT") {
        // A timed-out mutation may have reached GitHub. Discard even complete
        // output; the caller must reconcile remote state before any retry.
        throw new GitHubApiError(
          "command_failed",
          "GitHub API subprocess collection timed out (ETIMEDOUT)",
          {
            operation,
            cause: Object.assign(new Error("Subprocess collection timed out"), {
              code: "ETIMEDOUT",
            }),
          },
        );
      }
      if (errorCode(result.error) === "ENOBUFS") {
        // Neither partially collected output nor the provider's raw error is
        // trustworthy after overflow. Keep the cause code, not its payload.
        throw new GitHubApiError(
          "command_failed",
          `GitHub API command output exceeded the ${maxBuffer}-byte collection limit`,
          {
            operation,
            cause: Object.assign(new Error("Subprocess output limit exceeded"), {
              code: "ENOBUFS",
            }),
          },
        );
      }
      throw new GitHubApiError("command_failed", result.error.message, {
        operation,
        cause: result.error,
      });
    }
    if (result.status !== 0) {
      let response = null;
      try {
        if (result.stdout?.trim()) response = parseIncludedResponse(result.stdout);
      } catch {
        // The command failure remains authoritative when its response is malformed.
      }
      // gh exits nonzero for an authorized conditional GET's valid 304. Keep its
      // headers so the caller can validate the exact cached representation.
      if (
        response?.status === 304 &&
        args.includes("--include") &&
        args.some((argument) => argument.startsWith("If-None-Match: ")) &&
        args[args.indexOf("--method") + 1] === "GET"
      )
        return result.stdout;
      // gh also exits nonzero for GraphQL errors in a complete HTTP 200
      // response. Preserve the typed provider failure before the CLI exit can
      // disguise it as a transport error; partial mutation data is still refused.
      if (response && args[0] === "api" && args[1] === "graphql") {
        const error = graphqlResponseError(response, operation);
        if (error) throw error;
      }
      throw new GitHubApiError(
        "command_failed",
        result.stderr.trim() || `${operation} failed with exit ${result.status}`,
        {
          operation,
          status: response?.status ?? null,
          rateLimit: response ? rateLimitFromResponse(response) : null,
          retryAfter: response?.headers.get("retry-after") ?? null,
          requestId: response?.headers.get("x-github-request-id") ?? null,
          responseDate: response?.headers.get("date") ?? null,
          responseBytes: response?.bodyBytes ?? null,
        },
      );
    }
    checkCoordinatorDeadline();
    return args.includes("--include") ? result.stdout : result.stdout.trim();
  };
}

function responseError(error: unknown, operation: string) {
  if (error instanceof GitHubApiError) return error;
  return new GitHubApiError("invalid_response", errorMessage(error), { operation, cause: error });
}

export class GitHubApiClient {
  readonly run: GitHubRunner;
  readonly observations: {
    operation: string;
    query_sha256?: string;
    status: number | null;
    request_id: string | null;
    date: string | null;
    bytes: number;
    bytes_known: boolean;
    elapsed_ms: number;
    rate: GitHubRateLimit | null;
    failure?: string;
  }[] = [];
  constructor(run: GitHubRunner = createGitHubRunner()) {
    this.run = run;
  }

  command(args: readonly string[], input?: string) {
    return this.run(args, input);
  }

  private observe(
    operation: string,
    started: number,
    response?: IncludedResponse,
    error?: unknown,
    query?: string,
  ) {
    this.observations.push({
      operation,
      ...(query ? { query_sha256: createHash("sha256").update(query).digest("hex") } : {}),
      status: response?.status ?? (error instanceof GitHubApiError ? error.status : null),
      request_id:
        response?.headers.get("x-github-request-id") ??
        (error instanceof GitHubApiError ? error.requestId : null),
      date:
        response?.headers.get("date") ??
        (error instanceof GitHubApiError ? error.responseDate : null),
      bytes: response
        ? (response.bodyBytes ?? 0)
        : error instanceof GitHubApiError
          ? (error.responseBytes ?? 0)
          : 0,
      bytes_known:
        response?.bodyBytes !== undefined ||
        (error instanceof GitHubApiError && error.responseBytes !== null),
      elapsed_ms: Date.now() - started,
      rate: response
        ? rateLimitFromResponse(response)
        : error instanceof GitHubApiError
          ? error.rateLimit
          : null,
      ...(error ? { failure: sanitizeOperationError(error).code } : {}),
    });
  }

  request(
    method: string,
    endpoint: string,
    body: unknown = null,
    headers: Readonly<Record<string, string>> = {},
  ) {
    const started = Date.now();
    const operation = `${method} ${endpoint}`;
    if (
      Object.entries(headers).some(
        ([name, value]) => !/^[A-Za-z0-9-]+$/u.test(name) || /[\r\n]/u.test(value),
      )
    )
      throw new Error("Invalid GitHub REST request header");
    const input = body === null ? undefined : `${JSON.stringify(body)}\n`;
    let response;
    try {
      response = parseIncludedResponse(
        this.command(
          [
            "api",
            "--include",
            endpoint,
            "--method",
            method,
            ...Object.entries(headers).flatMap(([name, value]) => [
              "--header",
              `${name}: ${value}`,
            ]),
            ...(body === null ? [] : ["--input", "-"]),
          ],
          input,
        ),
      );
    } catch (error) {
      this.observe(operation, started, undefined, error);
      throw responseError(error, operation);
    }
    this.observe(operation, started, response);
    return { ...response, rateLimit: rateLimitFromResponse(response) };
  }

  graphql(query: string, variables: Readonly<Record<string, unknown>> = {}) {
    const started = Date.now();
    const operation = "POST graphql";
    let response;
    try {
      response = parseIncludedResponse(
        this.command(
          ["api", "graphql", "--include", "--input", "-"],
          `${JSON.stringify({ query, variables })}\n`,
        ),
      );
    } catch (error) {
      this.observe(operation, started, undefined, error, query);
      throw responseError(error, operation);
    }
    const rateLimit = rateLimitFromResponse(response);
    const error = graphqlResponseError(response, operation);
    if (error) {
      this.observe(operation, started, response, error, query);
      throw error;
    }
    this.observe(operation, started, response, undefined, query);
    if (!response.body || typeof response.body !== "object" || !("data" in response.body)) {
      throw new GitHubApiError("invalid_response", "GitHub GraphQL response omitted data", {
        operation,
        status: response.status ?? null,
        rateLimit,
      });
    }
    return { data: response.body.data, rateLimit, response };
  }

  paginateRest(
    this: GitHubRestReader,
    endpoint: string,
    {
      select = (body) => body,
      identity,
      totalCount = null,
      label = "GitHub collection",
    }: {
      select?: (body: unknown) => unknown;
      identity: (value: unknown) => unknown;
      totalCount?: ((body: unknown) => number | null) | null;
      label?: string;
    },
  ) {
    if (typeof identity !== "function") throw new Error("REST pagination requires identity");
    const records: unknown[] = [];
    const identities = new Set<string | number>();
    const pages = new Set<string>();
    let expectedTotal: number | null = null;
    let next: string | null = endpoint;
    while (next) {
      if (pages.has(next)) throw new Error(`${label} pagination did not advance`);
      pages.add(next);
      const response = this.request("GET", next);
      const values = select(response.body);
      if (!Array.isArray(values)) throw new Error(`${label} response is incomplete`);
      const reported = totalCount === null ? null : totalCount(response.body);
      if (reported !== null) {
        if (!Number.isSafeInteger(reported) || reported < 0)
          throw new Error(`${label} total is invalid`);
        expectedTotal ??= reported;
        if (expectedTotal !== reported) throw new Error(`${label} total changed during pagination`);
      }
      const pageRecords: readonly unknown[] = values;
      for (const value of pageRecords) {
        const id = identity(value);
        if ((typeof id !== "string" && typeof id !== "number") || !id || identities.has(id))
          throw new Error(`${label} contains a missing or duplicate ID`);
        identities.add(id);
        records.push(value);
      }
      if (expectedTotal !== null && records.length > expectedTotal)
        throw new Error(`${label} count exceeds reported total`);
      next = nextLink(response.headers);
    }
    if (expectedTotal !== null && records.length !== expectedTotal)
      throw new Error(`${label} count does not match reported total`);
    return records;
  }
}
