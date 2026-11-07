// One bounded request/redirect chain. No recipes, commands or caller-selected code execute.
import { isRecord, errorMessage } from "./runtime-values.mts";
import { fileURLToPath } from "node:url";
import path from "node:path";
export async function boundedDiscoveryRequest(input: unknown, fetcher: typeof fetch = fetch) {
  if (
    !isRecord(input) ||
    typeof input.url !== "string" ||
    typeof input.method !== "string" ||
    !["GET", "HEAD"].includes(input.method) ||
    input.body !== undefined ||
    input.conditionalEtag !== undefined ||
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
  let url = new URL(input.url);
  const initialUrl = url.href;
  const method = input.method;
  const started = performance.now();
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
      if (
        url.origin === "https://api.github.com" &&
        (input.binary !== true ||
          method !== "GET" ||
          url.href !== initialUrl ||
          !/^\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/artifacts\/[1-9][0-9]*\/zip$/u.test(
            url.pathname,
          ))
      )
        throw new Error(
          "GitHub metadata must use the configured SDK; only the original artifact byte route is retained",
        );
      if (requests >= input.maxRequests) throw new Error("Redirect/request budget exhausted");
      const remaining = input.timeout - (performance.now() - started);
      if (remaining <= 0) throw new Error("Request deadline exhausted");
      requests++;
      const response = await fetcher(url, {
        method,
        redirect: "manual",
        signal: AbortSignal.timeout(Math.ceil(remaining)),
        headers: {
          "User-Agent": "Portcove bounded discovery",
          Accept: "application/vnd.github+json",
          ...(url.origin === "https://api.github.com" && typeof input.token === "string"
            ? { Authorization: `Bearer ${input.token}` }
            : {}),
        },
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
