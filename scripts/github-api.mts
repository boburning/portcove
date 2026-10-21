import { errorCode, errorMessage, isRecord } from "./runtime-values.mts";
import type { SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { spawnSync } from "node:child_process";
import {
  coordinatorCommandTimeout,
  checkCoordinatorDeadline,
} from "./release-coordinator-deadline.mts";

export interface GitHubRateLimit {
  resource: string | null;
  limit: number | null;
  remaining: number | null;
  used: number | null;
  resetAt: string | null;
  cost?: number | null;
}
export interface IncludedResponse {
  status?: number;
  headers: ReadonlyMap<string, string>;
  body: unknown;
}
export interface GitHubRestReader {
  request(method: string, endpoint: string): IncludedResponse;
}
interface GitHubErrorDetails {
  cause?: unknown;
  operation?: string | null;
  status?: number | null;
  rateLimit?: GitHubRateLimit | null;
}
export type GitHubRunner = (args: readonly string[], input?: string) => string;
export type OperationStatus = "planned" | "succeeded" | "partial" | "unknown" | "failed";
interface EnvelopeInput {
  operation: string;
  status: unknown;
  summary: string;
  evidence?: unknown;
  error?: unknown;
}
interface OperationEnvelope<Evidence> {
  schema_version: 1;
  operation: string;
  status: OperationStatus;
  summary: string;
  evidence: Evidence;
  error: ReturnType<typeof sanitizeOperationError> | null;
}

export class GitHubApiError extends Error {
  readonly code: string;
  readonly operation: string | null;
  readonly status: number | null;
  readonly rateLimit: GitHubRateLimit | null;
  constructor(code: string, message: string, details: GitHubErrorDetails = {}) {
    super(message, details.cause ? { cause: details.cause } : undefined);
    this.name = "GitHubApiError";
    this.code = code;
    this.operation = details.operation ?? null;
    this.status = details.status ?? null;
    this.rateLimit = details.rateLimit ?? null;
  }
}

const operationStatuses = new Set(["planned", "succeeded", "partial", "unknown", "failed"]);

export function sanitizeOperationError(error: unknown) {
  const raw: unknown = (isRecord(error) ? error.message : undefined) ?? error ?? "unknown error";
  const message = String(raw)
    .replace(/(?:ghp|github_pat)_[A-Za-z0-9_]+/gu, "[REDACTED]")
    .replace(/\b(token|authorization)\s*[:=]\s*\S+/giu, "$1=[REDACTED]")
    .slice(0, 2000);
  return {
    code: errorCode(error) ?? "operation_failed",
    message,
  };
}

export function githubOperationEnvelope<Evidence>(
  options: EnvelopeInput & { evidence: Evidence },
): OperationEnvelope<Evidence>;
export function githubOperationEnvelope(options: EnvelopeInput): OperationEnvelope<unknown>;
export function githubOperationEnvelope({
  operation,
  status,
  summary,
  evidence = {},
  error = null,
}: EnvelopeInput): OperationEnvelope<unknown> {
  if (typeof operation !== "string" || !operation) throw new Error("operation is required");
  if (typeof status !== "string" || !operationStatuses.has(status))
    throw new Error(`unsupported operation status: ${String(status)}`);
  if (typeof summary !== "string" || !summary) throw new Error("operation summary is required");
  const checkedStatus =
    status === "planned" || status === "succeeded" || status === "partial" || status === "failed"
      ? status
      : "unknown";
  return {
    schema_version: 1,
    operation,
    status: checkedStatus,
    summary,
    evidence,
    error: error === null ? null : sanitizeOperationError(error),
  };
}

export function parseIncludedResponse(output: unknown): IncludedResponse {
  const raw: unknown = output ?? "";
  const text = String(raw).trim();
  if (!text) return { headers: new Map<string, string>(), body: null };
  if (text.startsWith("{") || text.startsWith("[")) {
    return { headers: new Map<string, string>(), body: JSON.parse(text) };
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
  const bodyText = text.slice((block.index ?? 0) + block[0].length).trim();
  return { status, headers, body: bodyText ? JSON.parse(bodyText) : null };
}

function numericHeader(headers: ReadonlyMap<string, string>, name: string) {
  const raw = headers.get(name.toLowerCase());
  if (raw === undefined) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function rateLimitFromResponse(response: IncludedResponse): GitHubRateLimit {
  const resource = response.headers.get("x-ratelimit-resource") ?? null;
  const resetSeconds = numericHeader(response.headers, "x-ratelimit-reset");
  const headerRate = {
    resource,
    limit: numericHeader(response.headers, "x-ratelimit-limit"),
    remaining: numericHeader(response.headers, "x-ratelimit-remaining"),
    used: numericHeader(response.headers, "x-ratelimit-used"),
    resetAt: resetSeconds === null ? null : new Date(resetSeconds * 1000).toISOString(),
  };
  const body = response.body;
  const bodyRate = isRecord(body) && isRecord(body.data) ? body.data.rateLimit : undefined;
  if (!isRecord(bodyRate)) return headerRate;
  return {
    resource: resource ?? "graphql",
    limit:
      typeof bodyRate.limit === "number" && Number.isSafeInteger(bodyRate.limit)
        ? bodyRate.limit
        : headerRate.limit,
    remaining:
      typeof bodyRate.remaining === "number" && Number.isSafeInteger(bodyRate.remaining)
        ? bodyRate.remaining
        : headerRate.remaining,
    used:
      typeof bodyRate.used === "number" && Number.isSafeInteger(bodyRate.used)
        ? bodyRate.used
        : headerRate.used,
    resetAt: typeof bodyRate.resetAt === "string" ? bodyRate.resetAt : headerRate.resetAt,
    cost:
      typeof bodyRate.cost === "number" && Number.isSafeInteger(bodyRate.cost)
        ? bodyRate.cost
        : null,
  };
}

export function nextLink(headers: ReadonlyMap<string, string>) {
  const value = headers.get("link");
  if (!value) return null;
  const matches = [...value.matchAll(/<([^>]+)>;\s*rel="([^"]+)"/gu)];
  const next = matches.find((match) => (match[2] ?? "").split(/\s+/u).includes("next"));
  return next?.[1] ?? null;
}

export function githubRateLimitMessage(
  rate: Pick<GitHubRateLimit, "remaining" | "resetAt"> | null | undefined,
  prefix = "GitHub API rate limit",
) {
  const remaining = rate?.remaining ?? "unknown";
  const reset = rate?.resetAt ?? "unknown";
  return `${prefix}: ${remaining} points remain; reset at ${reset}`;
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
      throw new GitHubApiError(
        "command_failed",
        result.stderr.trim() || `${operation} failed with exit ${result.status}`,
        {
          operation,
          status: response?.status ?? null,
          rateLimit: response ? rateLimitFromResponse(response) : null,
        },
      );
    }
    checkCoordinatorDeadline();
    return result.stdout.trim();
  };
}

function responseError(error: unknown, operation: string) {
  if (error instanceof GitHubApiError) return error;
  return new GitHubApiError("invalid_response", errorMessage(error), { operation, cause: error });
}

export class GitHubApiClient {
  readonly run: GitHubRunner;
  constructor(run: GitHubRunner = createGitHubRunner()) {
    this.run = run;
  }

  command(args: readonly string[], input?: string) {
    return this.run(args, input);
  }

  request(method: string, endpoint: string, body: unknown = null) {
    const operation = `${method} ${endpoint}`;
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
            ...(body === null ? [] : ["--input", "-"]),
          ],
          input,
        ),
      );
    } catch (error) {
      throw responseError(error, operation);
    }
    return { ...response, rateLimit: rateLimitFromResponse(response) };
  }

  graphql(query: string, variables: Readonly<Record<string, unknown>> = {}) {
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
      throw responseError(error, operation);
    }
    const rateLimit = rateLimitFromResponse(response);
    const errors = isRecord(response.body) ? response.body.errors : undefined;
    if (Array.isArray(errors) && errors.length) {
      const message = errors
        .map((error: unknown) =>
          isRecord(error) && typeof error.message === "string" ? error.message : "unknown error",
        )
        .join("; ");
      throw new GitHubApiError(
        "graphql_error",
        `${message}${rateLimit.remaining !== null ? ` (${githubRateLimitMessage(rateLimit)})` : ""}`,
        { operation, status: response.status ?? null, rateLimit },
      );
    }
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
