import { errorCode, isRecord } from "./runtime-values.mts";

export interface GitHubRateLimit {
  resource: string | null;
  limit: number | null;
  remaining: number | null;
  used: number | null;
  resetAt: string | null;
  cost?: number | null;
}
export interface GitHubApiObservation {
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
  attempt: number;
  dispatched: boolean;
}
export interface GitHubMetadataResponse {
  status?: number;
  headers: ReadonlyMap<string, string>;
  body: unknown;
  /** Actual received body bytes, before JSON decoding. */
  bodyBytes?: number;
}
export interface GitHubRestReader {
  request(method: string, endpoint: string): GitHubMetadataResponse;
}
interface GitHubErrorDetails {
  cause?: unknown;
  operation?: string | null;
  status?: number | null;
  rateLimit?: GitHubRateLimit | null;
  retryAfter?: string | null;
  requestId?: string | null;
  responseDate?: string | null;
  responseBytes?: number | null;
}
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
  readonly retryAfter: string | null;
  readonly requestId: string | null;
  readonly responseDate: string | null;
  readonly responseBytes: number | null;
  constructor(code: string, message: string, details: GitHubErrorDetails = {}) {
    super(message, details.cause ? { cause: details.cause } : undefined);
    this.name = "GitHubApiError";
    this.code = code;
    this.operation = details.operation ?? null;
    this.status = details.status ?? null;
    this.rateLimit = details.rateLimit ?? null;
    this.retryAfter = details.retryAfter ?? null;
    this.requestId = details.requestId ?? null;
    this.responseDate = details.responseDate ?? null;
    this.responseBytes = details.responseBytes ?? null;
  }
}

const operationStatuses = new Set(["planned", "succeeded", "partial", "unknown", "failed"]);

export function sanitizeOperationError(
  error: unknown,
  { secrets = [] }: { secrets?: readonly string[] } = {},
) {
  // SDK errors retain requests, responses and nested causes. Only these two
  // public fields belong to the existing operation envelope; never stringify
  // an arbitrary thrown object (including its custom toString implementation).
  const raw = typeof error === "string" ? error : isRecord(error) ? error.message : undefined;
  const redact = (value: string) => {
    const canonicalEscapes = (text: string) =>
      text.replace(/%[0-9a-f]{2}/giu, (escape) => escape.toUpperCase());
    value = canonicalEscapes(value);
    for (const secret of secrets) {
      if (!secret) continue;
      for (const spelling of new Set([secret, encodeURIComponent(secret)]))
        value = value.split(canonicalEscapes(spelling)).join("[REDACTED]");
    }
    return (
      value
        .replace(/https?:\/\/[^\s<>"']+/giu, (text) => {
          try {
            const url = new URL(text);
            if (url.username || url.password) {
              url.username = "[REDACTED]";
              url.password = "";
            }
            for (const name of [...url.searchParams.keys()])
              if (
                /token|authorization|credential|secret|password|signature|^sig$|^key$|jwt/iu.test(
                  name,
                )
              )
                url.searchParams.set(name, "[REDACTED]");
            // Error fragments are not provider identity evidence.
            url.hash = "";
            return url.href;
          } catch {
            return "[REDACTED URL]";
          }
        })
        .replace(/(?:gh[pousr]|github_pat)_[A-Za-z0-9_.~+/=-]+/gu, "[REDACTED]")
        // Consume the complete field, including its authentication scheme.
        .replace(
          /\b(token|authorization)\s*[:=]\s*[^\r\n]*(?:\r?\n[\t ]+[^\r\n]*)*/giu,
          "$1=[REDACTED]",
        )
        .replace(/\b(Bearer|Basic)\s+[^\s,"'<>]+/giu, "$1 [REDACTED]")
    );
  };
  const candidateCode = redact(errorCode(error) ?? "operation_failed");
  return {
    code: /^[a-z][a-z0-9_-]{0,63}$/iu.test(candidateCode) ? candidateCode : "operation_failed",
    message: redact(typeof raw === "string" ? raw : "unknown error").slice(0, 2000),
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

function numericHeader(headers: ReadonlyMap<string, string>, name: string) {
  const raw = headers.get(name.toLowerCase());
  if (raw === undefined) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function rateLimitFromResponse(response: GitHubMetadataResponse): GitHubRateLimit {
  const resource = response.headers.get("x-ratelimit-resource") ?? null;
  const resetSeconds = numericHeader(response.headers, "x-ratelimit-reset");
  const resetMilliseconds = resetSeconds === null ? NaN : resetSeconds * 1000;
  const headerRate = {
    resource,
    limit: numericHeader(response.headers, "x-ratelimit-limit"),
    remaining: numericHeader(response.headers, "x-ratelimit-remaining"),
    used: numericHeader(response.headers, "x-ratelimit-used"),
    resetAt: Number.isFinite(resetMilliseconds) && resetMilliseconds <= 8_640_000_000_000_000
      ? new Date(resetMilliseconds).toISOString() : null,
  };
  const body = response.body;
  const bodyRate = isRecord(body) && isRecord(body.data) ? body.data.rateLimit : undefined;
  if (!isRecord(bodyRate)) return headerRate;
  return {
    resource: resource ?? "graphql",
    limit:
      typeof bodyRate.limit === "number" && Number.isSafeInteger(bodyRate.limit) && bodyRate.limit >= 0
        ? bodyRate.limit
        : headerRate.limit,
    remaining:
      typeof bodyRate.remaining === "number" && Number.isSafeInteger(bodyRate.remaining) && bodyRate.remaining >= 0
        ? bodyRate.remaining
        : headerRate.remaining,
    used:
      typeof bodyRate.used === "number" && Number.isSafeInteger(bodyRate.used) && bodyRate.used >= 0
        ? bodyRate.used
        : headerRate.used,
    resetAt: typeof bodyRate.resetAt === "string" && Number.isFinite(Date.parse(bodyRate.resetAt)) ? bodyRate.resetAt : headerRate.resetAt,
    cost:
      typeof bodyRate.cost === "number" && Number.isSafeInteger(bodyRate.cost) && bodyRate.cost >= 0
        ? bodyRate.cost
        : null,
  };
}

export type IncludedResponse = GitHubMetadataResponse;

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
