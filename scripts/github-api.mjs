import { spawnSync } from "node:child_process";

export class GitHubApiError extends Error {
  constructor(code, message, details = {}) {
    super(message, details.cause ? { cause: details.cause } : undefined);
    this.name = "GitHubApiError";
    this.code = code;
    this.operation = details.operation ?? null;
    this.status = details.status ?? null;
    this.rateLimit = details.rateLimit ?? null;
  }
}

const operationStatuses = new Set(["planned", "succeeded", "partial", "unknown", "failed"]);

export function sanitizeOperationError(error) {
  const message = String(error?.message ?? error ?? "unknown error")
    .replace(/(?:ghp|github_pat)_[A-Za-z0-9_]+/gu, "[REDACTED]")
    .replace(/\b(token|authorization)\s*[:=]\s*\S+/giu, "$1=[REDACTED]")
    .slice(0, 2000);
  return {
    code: typeof error?.code === "string" ? error.code : "operation_failed",
    message,
  };
}

export function githubOperationEnvelope({
  operation,
  status,
  summary,
  evidence = {},
  error = null,
}) {
  if (typeof operation !== "string" || !operation) throw new Error("operation is required");
  if (!operationStatuses.has(status)) throw new Error(`unsupported operation status: ${status}`);
  if (typeof summary !== "string" || !summary) throw new Error("operation summary is required");
  return {
    schema_version: 1,
    operation,
    status,
    summary,
    evidence,
    error: error === null ? null : sanitizeOperationError(error),
  };
}

export function parseIncludedResponse(output) {
  const text = String(output ?? "").trim();
  if (!text) return { headers: new Map(), body: null };
  if (text.startsWith("{") || text.startsWith("[")) {
    return { headers: new Map(), body: JSON.parse(text) };
  }

  const blocks = [...text.matchAll(/(?:^|\r?\n)(HTTP\/[^\r\n]+\r?\n(?:[^\r\n]*\r?\n)*?)\r?\n/gmu)];
  const block = blocks.at(-1);
  if (!block) throw new Error("GitHub API response did not contain JSON or HTTP headers");
  const lines = block[1].trim().split(/\r?\n/u);
  const status = Number(lines.shift()?.match(/^HTTP\/\S+\s+(\d+)/u)?.[1]);
  if (!Number.isInteger(status)) throw new Error("GitHub API response had an invalid HTTP status");
  const headers = new Map();
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator < 1) throw new Error(`GitHub API response had a malformed header: ${line}`);
    headers.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
  }
  const bodyText = text.slice((block.index ?? 0) + block[0].length).trim();
  return { status, headers, body: bodyText ? JSON.parse(bodyText) : null };
}

export function numericHeader(headers, name) {
  const raw = headers.get(name.toLowerCase());
  if (raw === undefined) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function rateLimitFromResponse(response) {
  const resource = response.headers.get("x-ratelimit-resource") ?? null;
  const resetSeconds = numericHeader(response.headers, "x-ratelimit-reset");
  const headerRate = {
    resource,
    limit: numericHeader(response.headers, "x-ratelimit-limit"),
    remaining: numericHeader(response.headers, "x-ratelimit-remaining"),
    used: numericHeader(response.headers, "x-ratelimit-used"),
    resetAt: resetSeconds === null ? null : new Date(resetSeconds * 1000).toISOString(),
  };
  const bodyRate = response.body?.data?.rateLimit;
  if (!bodyRate) return headerRate;
  return {
    resource: resource ?? "graphql",
    limit: Number.isSafeInteger(bodyRate.limit) ? bodyRate.limit : headerRate.limit,
    remaining: Number.isSafeInteger(bodyRate.remaining) ? bodyRate.remaining : headerRate.remaining,
    used: Number.isSafeInteger(bodyRate.used) ? bodyRate.used : headerRate.used,
    resetAt: typeof bodyRate.resetAt === "string" ? bodyRate.resetAt : headerRate.resetAt,
    cost: Number.isSafeInteger(bodyRate.cost) ? bodyRate.cost : null,
  };
}

export function nextLink(headers) {
  const value = headers.get("link");
  if (!value) return null;
  const matches = [...value.matchAll(/<([^>]+)>;\s*rel="([^"]+)"/gu)];
  const next = matches.find((match) => match[2].split(/\s+/u).includes("next"));
  return next?.[1] ?? null;
}

export function githubRateLimitMessage(rate, prefix = "GitHub API rate limit") {
  const remaining = rate?.remaining ?? "unknown";
  const reset = rate?.resetAt ?? "unknown";
  return `${prefix}: ${remaining} points remain; reset at ${reset}`;
}

export function createGitHubRunner({
  cwd = process.cwd(),
  command = "gh",
  spawn = spawnSync,
  maxBuffer,
} = {}) {
  return (args, input) => {
    const result = spawn(command, args, {
      cwd,
      encoding: "utf8",
      input,
      ...(maxBuffer === undefined ? {} : { maxBuffer }),
      stdio: input === undefined ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const operation = `gh ${args.slice(0, 3).join(" ")}`;
    if (result.error) {
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
    return result.stdout.trim();
  };
}

function responseError(error, operation) {
  if (error instanceof GitHubApiError) return error;
  return new GitHubApiError("invalid_response", error.message, { operation, cause: error });
}

export class GitHubApiClient {
  constructor(run = createGitHubRunner()) {
    this.run = run;
  }

  command(args, input) {
    return this.run(args, input);
  }

  request(method, endpoint, body = null) {
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

  graphql(query, variables = {}) {
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
    const errors = response.body?.errors;
    if (Array.isArray(errors) && errors.length) {
      const message = errors
        .map((error) => (typeof error?.message === "string" ? error.message : "unknown error"))
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
    endpoint,
    { select = (body) => body, identity, totalCount = null, label = "GitHub collection" },
  ) {
    if (typeof identity !== "function") throw new Error("REST pagination requires identity");
    const records = [];
    const identities = new Set();
    const pages = new Set();
    let expectedTotal = null;
    let next = endpoint;
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
      for (const value of values) {
        const id = identity(value);
        if (!id || identities.has(id))
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
