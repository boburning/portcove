// One bounded request/redirect chain. No recipes, commands or caller-selected code execute.
import { isRecord, errorMessage } from "./runtime-values.mts";
import { fileURLToPath } from "node:url";
import path from "node:path";
export async function boundedDiscoveryRequest(input: unknown, fetcher: typeof fetch = fetch) {
  if (
    !isRecord(input) ||
    typeof input.url !== "string" ||
    typeof input.method !== "string" ||
    typeof input.cap !== "number" ||
    !Number.isSafeInteger(input.cap) ||
    input.cap < 1 ||
    input.cap > 2 * 1024 * 1024 ||
    typeof input.timeout !== "number" ||
    input.timeout <= 0 ||
    input.timeout > 20000 ||
    typeof input.maxRequests !== "number" ||
    !Number.isSafeInteger(input.maxRequests) ||
    input.maxRequests < 1 ||
    input.maxRequests > 5
  )
    throw new Error("Invalid bounded request");
  if (
    input.conditionalEtag !== undefined &&
    (typeof input.conditionalEtag !== "string" ||
      input.conditionalEtag.length > 512 ||
      /[\r\n]/u.test(input.conditionalEtag) ||
      input.method !== "GET" ||
      new URL(input.url).origin !== "https://api.github.com")
  )
    throw new Error("Invalid scoped discovery conditional request");
  let url = new URL(input.url);
  let method = input.method;
  let body = typeof input.body === "string" ? input.body : undefined;
  const started = Date.now();
  let requests = 0;
  let bytes = 0;
  let status = 0;
  let text = "";
  let headers: Record<string, string> = {};
  let backoff_until: string | undefined;
  try {
    for (;;) {
      if (url.protocol !== "https:" || url.username || url.password)
        throw new Error("Only credential-free HTTPS URLs are allowed");
      if (requests >= input.maxRequests) throw new Error("Redirect/request budget exhausted");
      const remaining = input.timeout - (Date.now() - started);
      if (remaining <= 0) throw new Error("Request deadline exhausted");
      requests++;
      const response = await fetcher(url, {
        method,
        redirect: "manual",
        signal: AbortSignal.timeout(remaining),
        headers: {
          "User-Agent": "Portcove bounded discovery",
          Accept: "application/vnd.github+json",
          ...(url.href === new URL(input.url).href && typeof input.conditionalEtag === "string"
            ? { "If-None-Match": input.conditionalEtag }
            : {}),
          ...(url.origin === "https://api.github.com" && typeof input.token === "string"
            ? { Authorization: `Bearer ${input.token}` }
            : {}),
        },
        ...(body === undefined ? {} : { body }),
      });
      status = response.status;
      headers = Object.fromEntries(response.headers);
      const chunks: Uint8Array[] = [];
      if (response.body)
        for await (const chunk of response.body) {
          const raw: unknown = chunk;
          if (!(raw instanceof Uint8Array)) throw new Error("Unexpected response stream chunk");
          bytes += raw.byteLength;
          if (bytes > input.cap) {
            await response.body.cancel().catch(() => {});
            throw new Error("Streaming response cap exhausted");
          }
          chunks.push(raw);
        }
      const buffer = Buffer.concat(chunks);
      if ([301, 302, 303, 307, 308].includes(status)) {
        const location = response.headers.get("location");
        if (!location) throw new Error("Redirect location missing");
        const next = new URL(location, url);
        if (method !== "GET" && method !== "HEAD")
          throw new Error("Mutation redirects require reconciliation");
        url = next;
        continue;
      }
      text = input.binary === true ? buffer.toString("base64") : buffer.toString("utf8");
      const retry = response.headers.get("retry-after");
      const reset = response.headers.get("x-ratelimit-reset");
      if (retry) {
        const seconds = Number(retry);
        const at = Number.isFinite(seconds) ? Date.now() + seconds * 1000 : Date.parse(retry);
        if (Number.isFinite(at)) backoff_until = new Date(at).toISOString();
      } else if (reset && response.headers.get("x-ratelimit-remaining") === "0")
        backoff_until = new Date(Number(reset) * 1000).toISOString();
      return {
        requests,
        bytes,
        status,
        headers,
        text,
        ...(backoff_until ? { backoff_until } : {}),
      };
    }
  } catch (error) {
    return {
      requests,
      bytes,
      status,
      headers,
      text: "",
      error: errorMessage(error),
      ...(backoff_until ? { backoff_until } : {}),
    };
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  let text = "";
  for await (const chunk of process.stdin) {
    text += String(chunk);
    if (Buffer.byteLength(text) > 3 * 1024 * 1024) throw new Error("Request envelope too large");
  }
  process.stdout.write(JSON.stringify(await boundedDiscoveryRequest(JSON.parse(text))));
}
