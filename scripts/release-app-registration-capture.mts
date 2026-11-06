import { createHash, createPrivateKey, createPublicKey } from "node:crypto";

import { createGitHubClient } from "./github-client.mts";
import { assertTrustedDirectNode } from "./release-direct-node-transport.mts";
import {
  inspectHostedReleaseAppIdentity,
  prepareHostedReleaseAppManifest,
  type HostedReleaseAppRole,
} from "./release-hosted-app-setup.mts";
import { prepareSemanticAppJwt } from "./release-semantic-issuer.mts";
import { isRecord } from "./runtime-values.mts";

const maximumBody = 128 * 1024;
export {
  createAppRegistrationStore,
  createCheckpointSigningStore,
  createHostedNativeProofStore,
  syncRegistrationDirectory,
} from "./release-owned-capture-store.mts";
export type { AppRegistrationStore } from "./release-owned-capture-store.mts";
import type { AppRegistrationStore } from "./release-owned-capture-store.mts";
const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");

export async function preflightHostedAppSetupSdk(): Promise<boolean> {
  try {
    const { Octokit } = await import("@octokit/core");
    if (typeof Octokit === "function") return true;
  } catch {
    // Keep package loader diagnostics out of the private setup command output.
  }
  process.stderr.write(
    "The locked GitHub SDK is unavailable. Install frozen repository dependencies before App setup.\n",
  );
  process.exitCode = 1;
  return false;
}

export function inspectAppRegistrationCallback(
  role: HostedReleaseAppRole,
  state: string,
  request: { method: string; host: string; remote_address: string; url: string },
) {
  if (
    !/^[a-f0-9]{64}$/u.test(state) ||
    request.method !== "GET" ||
    request.host !== "127.0.0.1:1456" ||
    !["127.0.0.1", "::ffff:127.0.0.1"].includes(request.remote_address) ||
    request.url.length > 4096 ||
    !request.url.startsWith("/") ||
    request.url.startsWith("//")
  )
    throw new Error("fixed registration callback boundary differs");
  const url = new URL(request.url, "http://127.0.0.1:1456");
  const fields = [...url.searchParams.keys()].sort().join(",");
  if (
    url.pathname !== new URL(prepareHostedReleaseAppManifest(role).redirect_url).pathname ||
    url.hash ||
    fields !== "code,state" ||
    url.searchParams.get("state") !== state ||
    !/^[A-Za-z0-9_-]{16,128}$/u.test(url.searchParams.get("code") ?? "")
  )
    throw new Error("registration callback state, role or code differs");
  return url.searchParams.get("code")!;
}

/** App setup owns private raw evidence, including a bounded prefix on failure.
 * Capture the original stream as the configured client consumes it. */
export async function readPrivateAppSetupResponse(options: {
  endpoint: string;
  method: "GET" | "POST" | "DELETE";
  bearer?: string;
  payload?: { permissions: { metadata: "read" } };
  timeout: number;
  maxBytes: number;
  version: string;
  userAgent?: string;
  transport?: typeof fetch;
}) {
  const { endpoint, method, bearer, payload, timeout, maxBytes, version, transport } = options;
  const allowed =
    bearer === undefined
      ? method === "POST" &&
        payload === undefined &&
        /^\/app-manifests\/[A-Za-z0-9_-]{16,128}\/conversions$/u.test(endpoint)
      : method === "POST"
        ? payload?.permissions.metadata === "read" &&
          /^\/app\/installations\/[1-9][0-9]*\/access_tokens$/u.test(endpoint)
        : payload === undefined &&
          (method === "DELETE"
            ? endpoint === "/installation/token"
            : endpoint === "/app" ||
              endpoint === "/app/installations?per_page=100" ||
              endpoint === "/installation/repositories?per_page=100" ||
              /^\/app\/installations\/[1-9][0-9]*$/u.test(endpoint));
  if (!allowed || (bearer !== undefined && (!bearer || /\s/u.test(bearer))))
    throw new Error("App setup request outside its private scope");
  const route = `https://api.github.com${endpoint}`;
  const chunks: Buffer[] = [];
  let length = 0,
    complete = false,
    failed = false;
  let observed: { status: number; headers: Headers } | undefined;
  let accepted = false;
  const client = await createGitHubClient({
    credential: bearer === undefined ? { kind: "anonymous" } : { kind: "explicit", token: bearer },
    deadline: performance.now() + timeout,
    requestTimeoutMs: timeout,
    maxBytes,
    // The underlying fetch refuses redirects. Preserve non-redirect provider
    // statuses in the 3xx range, such as 300, as private custody evidence.
    observeRedirects: true,
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": version,
      ...(options.userAgent ? { "user-agent": options.userAgent } : {}),
    },
    allowRequest(actual, url) {
      if (!transport) assertTrustedDirectNode("private App setup");
      return actual === method && url.href === route;
    },
    async fetch(input, init) {
      const headers = new Headers(init?.headers);
      if (bearer !== undefined) headers.set("authorization", `Bearer ${bearer}`);
      const response = await (transport ?? fetch)(input, { ...init, headers, redirect: "error" });
      observed = { status: response.status, headers: response.headers };
      if (method === "DELETE") {
        await response.body?.cancel();
        return new Response(null, { status: response.status, headers: response.headers });
      }
      const reader = response.body?.getReader();
      if (!reader) {
        failed = true;
        return response;
      }
      let cancelled = false;
      const cancelledOrAborted = () => cancelled || init?.signal?.aborted;
      const stream = new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            try {
              const part = await reader.read();
              if (cancelledOrAborted()) return;
              if (part.done) {
                complete = true;
                controller.close();
                return;
              }
              if (!(part.value instanceof Uint8Array))
                throw new Error("App setup body is not byte data");
              const retained = part.value.subarray(0, maxBytes - length);
              chunks.push(Buffer.from(retained));
              length += retained.byteLength;
              controller.enqueue(part.value);
            } catch (error) {
              if (cancelledOrAborted()) return;
              failed = true;
              controller.error(error);
              await reader.cancel().catch(() => {});
            }
          },
          cancel(reason) {
            cancelled = true;
            return reader.cancel(reason);
          },
        },
        { highWaterMark: 0 },
      );
      return new Response(stream, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    },
  });
  try {
    await client.request(`${method} ${route}`, {
      ...(payload === undefined ? {} : { data: { permissions: { metadata: "read" } } }),
      request: { parseSuccessResponseBody: false, portcove: { replay: "once", attempts: 0 } },
    });
    accepted = true;
  } catch {
    // Never include the conversion-code route, token or provider response in diagnostics.
    if (!observed) throw new Error("App setup transport unavailable");
  }
  if (!observed) throw new Error("App setup transport unavailable");
  return { ...observed, body: Buffer.concat(chunks, length), complete, failed, accepted };
}

/** One direct callback -> one conversion. No imported transcript or default
 * credential lookup. Failed/ambiguous effects stay pending for explicit
 * readback; the consumed closure can never issue a second conversion POST. */
export function createAppRegistrationCapture(options: {
  role: HostedReleaseAppRole;
  state: string;
  deadline: number;
  store: AppRegistrationStore;
  transport?: typeof fetch;
}) {
  const { role, state, deadline, store } = options;
  prepareHostedReleaseAppManifest(role);
  let consumed = false;
  const record = (name: string, value: unknown) =>
    store.write(name, Buffer.from(JSON.stringify(value)));
  const active = () => {
    if (!Number.isSafeInteger(deadline) || Date.now() >= deadline)
      throw new Error("original App registration deadline expired");
  };
  const request = async (kind: "conversion" | "app-readback", codeOrJwt: string) => {
    active();
    const conversion = kind === "conversion";
    let response: Awaited<ReturnType<typeof readPrivateAppSetupResponse>>;
    try {
      response = await readPrivateAppSetupResponse({
        endpoint: conversion ? `/app-manifests/${codeOrJwt}/conversions` : "/app",
        method: conversion ? "POST" : "GET",
        ...(conversion ? {} : { bearer: codeOrJwt }),
        timeout: Math.min(10000, deadline - Date.now()),
        maxBytes: maximumBody,
        version: "2026-03-10",
        userAgent: "portcove-fixed-app-registration",
        ...(options.transport ? { transport: options.transport } : {}),
      });
    } catch {
      await record(`${kind}-transport.json`, {
        response: "unavailable",
        effect: conversion ? "unknown" : "read-only",
        automatic_retry: false,
      });
      throw new Error("registration transport ambiguous; no retry");
    }
    const { body, complete } = response;
    let retained = body;
    if (role === "storage_writer") {
      // The approved extension retains its sole operational RSA key
      // separately in private custody, never unused OAuth/webhook credentials.
      // This is an explicitly filtered capture, not original response bytes.
      let projection: Record<string, unknown> = { unparsed: true };
      try {
        const raw: unknown = JSON.parse(body.toString("utf8"));
        if (isRecord(raw))
          projection = Object.fromEntries(
            ["id", "slug", "name", "owner", "permissions", "events"]
              .filter((key) => Object.hasOwn(raw, key))
              .map((key) => [key, raw[key]]),
          );
      } catch {
        /* No partial secret-bearing response is retained. */
      }
      retained = Buffer.from(JSON.stringify(projection));
    }
    try {
      await store.write(`${kind}.body`, retained);
      await record(`${kind}-response.json`, {
        status: response.status,
        complete,
        retained_bytes: retained.length,
        retained_sha256: sha(retained),
        ...(role === "storage_writer"
          ? {
              encoding: "storage-app-allowlist",
              observed_bytes: body.length,
              observed_sha256: sha(body),
            }
          : {}),
      });
    } catch {
      throw new Error("registration body or private retention failed; preserve pending intent");
    }
    if (response.failed)
      throw new Error("registration body or private retention failed; preserve pending intent");
    active();
    if (!complete || !response.accepted || response.status !== (conversion ? 201 : 200))
      throw new Error("registration response incomplete or refused; retain actual effects");
    return JSON.parse(body.toString("utf8")) as unknown;
  };
  return async (incoming: Parameters<typeof inspectAppRegistrationCallback>[2]) => {
    const code = inspectAppRegistrationCallback(role, state, incoming);
    active();
    if (consumed || deadline - Date.now() < 20000)
      throw new Error("registration already consumed or insufficient original deadline");
    consumed = true;
    await record("conversion-intent.json", {
      role,
      ...(role === "storage_writer" ? { code_sha256: sha(Buffer.from(code)) } : { code }),
      deadline,
      phase: "pending",
      effect: "unresolved",
      automatic_retry: false,
    });
    const converted = await request("conversion", code);
    if (
      !isRecord(converted) ||
      typeof converted.id !== "number" ||
      typeof converted.pem !== "string" ||
      Buffer.byteLength(converted.pem) > 16384
    )
      throw new Error("converted App identity or private key unavailable");
    inspectHostedReleaseAppIdentity(role, converted.id, converted);
    const pem = Buffer.from(converted.pem);
    try {
      const key = createPrivateKey(pem);
      const fingerprint = sha(createPublicKey(key).export({ type: "spki", format: "der" }));
      const jwt = prepareSemanticAppJwt(
        pem,
        converted.id,
        fingerprint,
        Math.floor(Date.now() / 1000),
      );
      await store.write("app.pem", pem);
      const observed = await request("app-readback", jwt);
      const identity = inspectHostedReleaseAppIdentity(role, converted.id, observed);
      if (
        !isRecord(observed) ||
        typeof observed.slug !== "string" ||
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(observed.slug) ||
        observed.slug.length > 100
      )
        throw new Error("authenticated App installation locator unavailable");
      const result = {
        ...identity,
        public_key_sha256: fingerprint,
        install_url: `https://github.com/apps/${observed.slug}/installations/new`,
        installation_repository_scope: "not-established",
        acceptance: "not-established",
        authority: "none",
        automatic_retry: false,
      };
      await record("result.json", result);
      active();
      return result;
    } finally {
      pem.fill(0);
    }
  };
}
