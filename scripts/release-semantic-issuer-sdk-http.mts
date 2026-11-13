import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGitHubClient } from "./github-client.mts";
import { GitHubApiError } from "./github-operation.mts";
import { assertTrustedDirectNode } from "./release-direct-node-transport.mts";
import { inspectSemanticIssuerRequest } from "./release-semantic-issuer-http.mts";

const maximumRequestBytes = 128 * 1024;
const maximumResponseBytes = 2 * 1024 * 1024;
const timeoutMilliseconds = 10_000;
const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const failure =
  "semantic credential HTTP transport failed; reconcile any attempted effect before retry";

/** Successor wire adapter. Appointment and credential provisioning stay with
 * the issuer owners, which must seal this entry point and its SDK closure. */
export async function runSemanticIssuerSdkRequest(
  input: unknown,
  options: { transport?: typeof fetch; deadline?: number } = {},
) {
  const request = inspectSemanticIssuerRequest(input);
  if (!options.transport) assertTrustedDirectNode("sealed semantic issuer");
  const route = `https://api.github.com/${request.endpoint}`;
  const deadline = Math.min(performance.now() + timeoutMilliseconds, options.deadline ?? Infinity);
  const chunks: Buffer[] = [];
  let length = 0;
  let complete = false;
  let response: { status: number; headers: [string, string][] } | undefined;
  const client = await createGitHubClient({
    credential: { kind: "explicit", token: request.token },
    deadline,
    requestTimeoutMs: timeoutMilliseconds,
    maxBytes: maximumResponseBytes,
    observeRedirects: true,
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2026-03-10",
      "user-agent": "portcove-fixed-semantic-broker",
      ...(request.body === null ? {} : { "content-type": "application/json" }),
    },
    allowRequest: (method, url) => method === request.method && url.href === route,
    async fetch(input, init) {
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${request.token}`);
      const original = await (options.transport ?? fetch)(input, {
        ...init,
        headers,
        redirect: "error",
      });
      if (original.redirected || redirectStatuses.has(original.status) || !original.body) {
        await original.body?.cancel();
        throw new Error(failure);
      }
      response = { status: original.status, headers: [...original.headers] };
      // The configured SDK owns cancellation, deadline and provider accounting.
      // Capture the private wire body only while that same request consumes it.
      const body = original.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(bytes, controller) {
            if ((length += bytes.byteLength) > maximumResponseBytes) throw new Error(failure);
            chunks.push(Buffer.from(bytes));
            controller.enqueue(bytes);
          },
          flush() {
            complete = true;
          },
        }),
      );
      return new Response(body, {
        status: original.status,
        statusText: original.statusText,
        headers: original.headers,
      });
    },
  });
  try {
    await client.request(`${request.method} ${route}`, {
      ...(request.body === null ? {} : { data: JSON.stringify(request.body) }),
      request: { parseSuccessResponseBody: false, portcove: { replay: "once", attempts: 0 } },
    });
  } catch (error) {
    // A complete provider HTTP refusal is still private readback evidence.
    // A local refusal, cancellation or incomplete response never is.
    if (!(error instanceof GitHubApiError) || !response || error.status !== response.status)
      throw new Error(failure);
  }
  if (!complete || !response || performance.now() >= deadline) throw new Error(failure);
  let body: unknown;
  try {
    body = JSON.parse(
      new TextDecoder("utf8", { fatal: true }).decode(Buffer.concat(chunks, length)),
    );
  } catch {
    throw new Error(failure);
  }
  if (performance.now() >= deadline) throw new Error(failure);
  return { ...response, body };
}

async function main() {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const raw of process.stdin) {
    const part: unknown = raw;
    if (!(Buffer.isBuffer(part) || typeof part === "string")) throw new Error(failure);
    const bytes = Buffer.from(part);
    if ((length += bytes.length) > maximumRequestBytes) throw new Error(failure);
    chunks.push(bytes);
  }
  const input: unknown = JSON.parse(Buffer.concat(chunks, length).toString("utf8"));
  const response = await runSemanticIssuerSdkRequest(input);
  // The parent owns this private pipe, including any minted credential.
  process.stdout.write(JSON.stringify(response));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write(failure + "\n");
    process.exitCode = 1;
  });
}
