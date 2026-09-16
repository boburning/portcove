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
